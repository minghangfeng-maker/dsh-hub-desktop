/**
 * The default connection transport: one WebSocket per connection, a device
 * token in the bearer header, and a liveness check the Hub can observe.
 *
 * The socket factory is injectable so tests never open a network connection and
 * so the handshake binding can change with the Hub contract without touching the
 * lifecycle. `ws` is loaded on first use: a Host that never enables the channel
 * does not pay for it, and a Host without it reports one failed attempt instead
 * of failing the whole connector.
 */

import { createRequire } from 'node:module'
import type { ChannelCloseEvent, ChannelSocket, ChannelTransport } from './types.ts'

/** Node's require, used to load the optional `ws` package from this process's own resolution paths. */
const requireFromHere = createRequire(import.meta.url)

/** Everything the socket factory needs to open one connection. */
export interface ChannelSocketRequest {
  /** Absolute `ws(s)://` URL of the Hub device endpoint. */
  readonly url: string
  /** Headers the device endpoint authenticates with. */
  readonly headers: Readonly<Record<string, string>>
  /** Subprotocols the Hub must select one of, when the handshake needs them. */
  readonly protocols?: readonly string[]
}

/**
 * One `ws` socket reduced to what this transport calls. Event payloads differ per
 * event name and the constructor comes from an external package, so the listener
 * parameter is `any`: this interface is a wire boundary, not business code.
 */
export interface ChannelWebSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate?(): void
  ping?(): void
  on(event: 'open' | 'error' | 'message' | 'close' | 'pong', listener: (...args: any[]) => void): void
}

/** Opens one physical connection. */
export type ChannelSocketFactory = (request: ChannelSocketRequest) => Promise<ChannelWebSocket>

/** A transport failure the status surface can name. */
export class ChannelTransportError extends Error {
  /**
   * @param code - stable machine-readable reason.
   * @param message - operator-facing sentence.
   * @param options - optional cause chain.
   */
  constructor(readonly code: 'transport-unavailable' | 'open-failed' | 'cancelled', message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = 'ChannelTransportError'
  }
}

/** Options of the default transport. */
export interface WebSocketTransportOptions {
  /** Endpoint path below the Hub origin; the frozen device relay by default. */
  readonly path?: string
  /** Ping cadence; two unanswered pings terminate the socket. */
  readonly keepaliveMs?: number
  /** Socket factory; `ws` loaded on first use by default. */
  readonly socketFactory?: ChannelSocketFactory
}

/** Device relay endpoint of the frozen mobile contract (`docs/20` + `mobile-plan/M4-冻结契约.md`). */
export const DEFAULT_DEVICE_CHANNEL_PATH = '/api/desktop/relay'

/** Ping cadence before the Hub contract says otherwise. */
const DEFAULT_KEEPALIVE_MS = 20_000

/** Missed pings that end a socket. */
const MAX_MISSED_PINGS = 2

/** Largest frame either side may send. */
const MAX_PAYLOAD_BYTES = 1024 * 1024

/** Constructor shape this transport needs from the external package. */
interface WebSocketConstructor {
  new (url: string, options: Record<string, unknown>): ChannelWebSocket
  new (url: string, protocols: string[], options: Record<string, unknown>): ChannelWebSocket
}

/**
 * Load `ws` from this Host process and check that what it exported is usable as a
 * constructor. The package is optional: a Host that does not carry it reports
 * `transport-unavailable` instead of failing the connector, and the Hub handshake
 * this transport presents is one of the frozen-contract decisions (the browser
 * built-in WebSocket cannot set the authorization header, so a ticket handshake
 * would replace this loader rather than widen it).
 * @returns the constructor.
 * @throws {ChannelTransportError} `transport-unavailable` when the package is missing or exports no constructor.
 */
function loadWebSocket(): WebSocketConstructor {
  let loaded: unknown
  try {
    loaded = requireFromHere('ws')
  } catch (error) {
    throw new ChannelTransportError('transport-unavailable', 'the ws package is not available in this Host', { cause: error })
  }
  // `require('ws')` answers either the module object or, when a bundler interops the
  // ESM default, the constructor itself (which also carries `.WebSocket`). Both are
  // the package: accept the function form instead of declaring the transport dead.
  if (typeof loaded === 'function') return loaded as WebSocketConstructor
  if (typeof loaded !== 'object' || loaded === null) {
    throw new ChannelTransportError('transport-unavailable', 'the ws package exported no module object')
  }
  const candidate: unknown = Reflect.get(loaded, 'WebSocket')
  if (typeof candidate === 'function') return candidate as WebSocketConstructor
  // The intermediate module object may itself expose the constructor as its default.
  const fallback: unknown = Reflect.get(loaded, 'default')
  if (typeof fallback === 'function') {
    const nested: unknown = Reflect.get(fallback, 'WebSocket')
    return (typeof nested === 'function' ? nested : fallback) as WebSocketConstructor
  }
  throw new ChannelTransportError('transport-unavailable', 'the ws package exported no WebSocket constructor')
}

/**
 * Load `ws` on first use and open one socket.
 * @param request - URL, headers, and optional subprotocols.
 * @returns the socket, once `open` fired.
 * @throws {ChannelTransportError} `open-failed` when the handshake failed.
 */
export async function openChannelWebSocket(request: ChannelSocketRequest): Promise<ChannelWebSocket> {
  const WebSocketClass = loadWebSocket()
  const options = { headers: { ...request.headers }, maxPayload: MAX_PAYLOAD_BYTES, handshakeTimeout: 15_000 }
  return await new Promise<ChannelWebSocket>((resolve, reject) => {
    const socket = request.protocols === undefined
      ? new WebSocketClass(request.url, options)
      : new WebSocketClass(request.url, [...request.protocols], options)
    const onOpen = (): void => {
      socket.on('error', () => undefined)
      resolve(socket)
    }
    socket.on('open', onOpen)
    socket.on('error', (error: unknown) => {
      reject(new ChannelTransportError('open-failed', 'the device channel could not be opened', { cause: error }))
    })
  })
}

/** Convert a close reason of either shape into text. */
function closeText(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason instanceof Uint8Array) return Buffer.from(reason).toString('utf8')
  return ''
}

/**
 * Wrap one socket in the channel surface, including the liveness check.
 * @param socket - open socket.
 * @param keepaliveMs - ping cadence.
 * @returns the channel socket.
 */
function wrapSocket(socket: ChannelWebSocket, keepaliveMs: number): ChannelSocket {
  let closed = false
  let missed = 0
  const messageListeners = new Set<(text: string) => void>()
  const closeListeners = new Set<(event: ChannelCloseEvent) => void>()
  const finish = (event: ChannelCloseEvent): void => {
    if (closed) return
    closed = true
    clearInterval(timer)
    for (const listener of [...closeListeners]) listener(event)
    messageListeners.clear()
    closeListeners.clear()
  }
  const timer = setInterval(() => {
    if (typeof socket.ping !== 'function') return
    if (missed >= MAX_MISSED_PINGS) {
      socket.terminate?.()
      finish({ code: 1001, reason: 'keepalive-timeout' })
      return
    }
    missed += 1
    try {
      socket.ping()
    } catch {
      // A ping on a socket that is already closing is not a new failure.
    }
  }, keepaliveMs)
  timer.unref?.()
  socket.on('pong', () => { missed = 0 })
  socket.on('message', (data: unknown) => {
    missed = 0
    const text = typeof data === 'string'
      ? data
      : data instanceof Uint8Array
        ? Buffer.from(data).toString('utf8')
        : Array.isArray(data)
          ? Buffer.concat(data.filter((part): part is Uint8Array => part instanceof Uint8Array)).toString('utf8')
          : ''
    if (text === '') return
    for (const listener of [...messageListeners]) listener(text)
  })
  socket.on('close', (code: unknown, reason: unknown) => {
    finish({ code: typeof code === 'number' ? code : 1006, reason: closeText(reason) })
  })
  socket.on('error', () => { finish({ code: 1006, reason: 'socket-error' }) })
  return {
    send(text) {
      if (closed) return
      socket.send(text)
    },
    close(reason) {
      if (closed) return
      socket.close(1000, reason)
    },
    onMessage(listener) {
      messageListeners.add(listener)
      return () => { messageListeners.delete(listener) }
    },
    onClose(listener) {
      closeListeners.add(listener)
      return () => { closeListeners.delete(listener) }
    },
  }
}

/**
 * Build the default transport.
 * @param options - endpoint path, ping cadence, and an optional socket factory.
 * @returns a transport the lifecycle retries.
 */
export function createWebSocketTransport(options: WebSocketTransportOptions = {}): ChannelTransport {
  const path = options.path ?? DEFAULT_DEVICE_CHANNEL_PATH
  const keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS
  const factory = options.socketFactory ?? openChannelWebSocket
  return {
    async open({ credentials, signal }) {
      if (signal.aborted) throw new ChannelTransportError('cancelled', 'the connection attempt was cancelled')
      const origin = new URL(credentials.hubOrigin)
      const socketUrl = new URL(path, `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}`)
      const socket = await factory({
        url: socketUrl.toString(),
        headers: {
          authorization: `Bearer ${credentials.token}`,
          origin: origin.origin,
          'x-dsh-node': credentials.nodeId,
        },
      })
      if (signal.aborted) {
        socket.close(1000, 'cancelled')
        throw new ChannelTransportError('cancelled', 'the connection attempt was cancelled')
      }
      return wrapSocket(socket, keepaliveMs)
    },
  }
}

/**
 * Reason text the lifecycle records when a connection ends.
 * @param event - close event from the socket.
 * @returns stable, log-safe text.
 */
export function closeReasonOf(event: ChannelCloseEvent): string {
  const reason = event.reason.trim()
  return reason === '' ? `closed-${String(event.code)}` : reason.slice(0, 120)
}
