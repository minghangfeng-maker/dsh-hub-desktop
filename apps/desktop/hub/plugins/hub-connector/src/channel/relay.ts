/**
 * The desktop end of the Hub relay: the outer `hello` / `open` / `frame` / `close`
 * envelope defined by `@dsh-hub/shared` (`packages/shared/src/api/mobile.ts`).
 *
 * This module moves frames; it does not translate them. One phone channel, opened
 * by the Hub, becomes one adapter instance whose own default HTTP/WS transport
 * talks to the local Host — the same transport, and therefore the same Peer and
 * `$events` clientId, the cloud node uses. Nothing here dials the Host.
 *
 * The relay opens an adapter only when the Hub says a phone actually connected, so
 * a desktop with the switch on and no phone never opens `$events` and never makes
 * the Host believe an owner Client is live.
 */

/** Protocol version of the mobile contract. */
export const RELAY_VERSION = 1

/** Where the desktop relay connects, relative to the Hub origin. */
export const RELAY_PATH = '/api/desktop/relay'

/** Channels one node may bridge at once; matches the Hub's `channelsPerNode`. */
export const MAX_CHANNELS = 2

/** Frames one channel may have queued or running before it reports overload. */
export const MAX_PENDING_FRAMES = 32

/** Longest channel identity the Hub may send. */
const MAX_CHANNEL_ID = 64

/** Capability flags the desktop reports in `hello`. */
export interface RelayCapabilities {
  readonly sessions: boolean
  readonly history: boolean
  readonly send: boolean
  readonly stop: boolean
  readonly stream: boolean
  readonly questions: boolean
  readonly approvals: boolean
  readonly create: boolean
}

/** One phone channel the Hub opened for this device. */
export interface RelayChannel {
  /** Hub-assigned channel identity; one per connected phone. */
  readonly channelId: string
  /** Node identity the Hub routed to this channel. */
  readonly nodeId: string
}

/** What the relay needs from one phone channel's adapter. */
export interface RelayAdapter {
  /**
   * Handle one phone frame.
   * @param frame - decoded `MobileClientFrame`; validation belongs to the adapter.
   * @param send - delivers one `MobileServerFrame` back to this channel.
   * @returns after the frame was accepted; a rejection is answered with an error frame.
   */
  dispatch(frame: unknown, send: (payload: unknown) => void): Promise<void>
  /**
   * Close the channel: the adapter settles its local pending approvals with `next`
   * before cancelling its event stream.
   * @returns after every resource is released; repeating it is allowed.
   */
  close(): Promise<void>
}

/**
 * Builds one adapter per phone channel, asynchronously: the shared factory probes
 * the Host before it returns.
 */
export type RelayAdapterFactory = (channel: RelayChannel) => Promise<RelayAdapter>

/** Collaborators the relay reaches outside itself. */
export interface DesktopRelayOptions {
  /** Hub-issued device identity, the same one the device report uses. */
  readonly deviceId: string
  /** Application version, for the Hub's compatibility display. */
  readonly clientVersion: string
  /** Whether the local Host is running; only the status leaves the device. */
  readonly hostStatus: () => 'running' | 'stopped' | 'starting'
  /** Capability flags, or null before the read-only probe finished. */
  readonly capabilities: () => RelayCapabilities | null
  /** Builds the adapter for one channel. */
  readonly adapter: RelayAdapterFactory
  /** Writes one envelope to the Hub socket. */
  readonly send: (text: string) => void
  /** Diagnostic sink; never receives frame payloads. */
  readonly log?: (message: string) => void
}

/** One inbound envelope, after validation. */
type InboundEnvelope =
  | { readonly type: 'open'; readonly channelId: string; readonly nodeId: string }
  | { readonly type: 'frame'; readonly channelId: string; readonly payload: unknown }
  | { readonly type: 'close'; readonly channelId: string; readonly code: string; readonly reason: string }

/** Frame types a phone may send; anything else never reaches an adapter. */
const CLIENT_FRAME_TYPES = new Set([
  'hello', 'sessions', 'history', 'create', 'send', 'stop',
  'subscribe', 'unsubscribe', 'answer-approval', 'answer-question', 'ping',
])

/** Whether a value is a non-empty string no longer than a channel id. */
function isChannelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CHANNEL_ID
}

/**
 * Validate one inbound relay envelope.
 * @param value - parsed JSON value.
 * @returns the envelope, or undefined when it is not one this build accepts.
 */
export function readRelayEnvelope(value: unknown): InboundEnvelope | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.v !== RELAY_VERSION) return undefined
  if (record.type === 'open' && isChannelId(record.channelId) && typeof record.nodeId === 'string') {
    return { type: 'open', channelId: record.channelId, nodeId: record.nodeId }
  }
  if (record.type === 'frame' && isChannelId(record.channelId) && Object.hasOwn(record, 'payload')) {
    return { type: 'frame', channelId: record.channelId, payload: record.payload }
  }
  if (record.type === 'close' && isChannelId(record.channelId) && typeof record.code === 'string'
    && typeof record.reason === 'string') {
    return { type: 'close', channelId: record.channelId, code: record.code, reason: record.reason.slice(0, 500) }
  }
  return undefined
}

/**
 * Whether a payload is a phone frame this relay forwards.
 * @param payload - value carried by a `frame` envelope.
 * @returns true only for a versioned object whose `type` is in the client set.
 */
export function isClientFrame(payload: unknown): payload is { readonly type: string; readonly requestId?: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  return record.v === RELAY_VERSION && typeof record.type === 'string' && CLIENT_FRAME_TYPES.has(record.type)
}

/**
 * Build the `hello` envelope.
 * @param options - device identity, host status, and capabilities.
 * @returns the JSON text to send before any other envelope.
 */
export function helloEnvelope(options: Pick<DesktopRelayOptions, 'deviceId' | 'clientVersion' | 'hostStatus' | 'capabilities'>): string {
  return JSON.stringify({
    v: RELAY_VERSION,
    type: 'hello',
    deviceId: options.deviceId,
    hostStatus: options.hostStatus(),
    capabilities: options.capabilities(),
    clientVersion: options.clientVersion,
  })
}

/**
 * Build one error frame the phone can attribute to its request.
 * @param payload - the phone frame that failed, when it named a request.
 * @param code - mobile error code.
 * @param message - short sentence.
 * @returns the JSON text to send.
 */
export function errorEnvelope(payload: unknown, code: string, message: string): string {
  const requestId = typeof payload === 'object' && payload !== null && Object.hasOwn(payload, 'requestId')
    ? Reflect.get(payload, 'requestId')
    : undefined
  return JSON.stringify({
    v: RELAY_VERSION,
    type: 'error',
    ...typeof requestId === 'string' ? { requestId } : {},
    code,
    message,
    retryable: false,
  })
}

/** One bridged channel: the adapter, its generation, and its serial queue. */
interface ChannelEntry {
  readonly adapter: Promise<RelayAdapter>
  readonly generation: number
  /** Tail of this channel's dispatch chain; every frame runs after the previous one. */
  tail: Promise<void>
  /** Frames waiting or running on this channel. */
  pending: number
  cancelled: boolean
}

/**
 * Follow one Hub relay socket for the life of a phone channel.
 *
 * One instance per socket. `open` starts an adapter, `frame` feeds it (the first
 * frames wait for a still-creating adapter), `close` retires it; `disconnected()`
 * retires every adapter when the socket dies without a `close` envelope.
 */
export class DesktopRelay {
  private readonly options: DesktopRelayOptions
  private readonly channels = new Map<string, ChannelEntry>()
  private generation = 0
  private closed = false

  /**
   * @param options - device identity, adapter factory, and the socket writer.
   */
  constructor(options: DesktopRelayOptions) {
    this.options = options
  }

  /** @returns the channels currently bridged. */
  get openChannels(): readonly string[] {
    return [...this.channels.keys()]
  }

  /** Send `hello`; call again after the probe result changed so the Hub re-reads capabilities. */
  hello(): void {
    if (this.closed) return
    this.options.send(helloEnvelope(this.options))
  }

  /**
   * Handle one inbound text frame.
   * @param text - complete envelope text.
   */
  receive(text: string): void {
    if (this.closed) return
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      this.options.log?.('relay: dropped a frame that is not JSON')
      return
    }
    const envelope = readRelayEnvelope(value)
    if (envelope === undefined) {
      this.options.log?.('relay: dropped an envelope this build does not accept')
      return
    }
    if (envelope.type === 'open') {
      this.openChannel(envelope.channelId, envelope.nodeId)
      return
    }
    const entry = this.channels.get(envelope.channelId)
    if (entry === undefined) {
      this.options.log?.(`relay: dropped a ${envelope.type} for an unknown channel`)
      return
    }
    if (envelope.type === 'close') {
      void this.retire(envelope.channelId, entry, `hub:${envelope.code}`)
      return
    }
    if (!isClientFrame(envelope.payload)) {
      this.options.send(JSON.stringify({ v: RELAY_VERSION, type: 'frame', channelId: envelope.channelId, payload: JSON.parse(errorEnvelope(envelope.payload, 'protocol', 'unsupported phone frame')) }))
      return
    }
    this.forward(envelope.channelId, entry, envelope.payload)
  }

  /**
   * The socket is gone: retire every adapter, each of which settles its pending
   * approvals with `next` before releasing its event stream.
   * @returns after every adapter closed.
   */
  async disconnected(): Promise<void> {
    this.closed = true
    const entries = [...this.channels.entries()]
    this.channels.clear()
    await Promise.all(entries.map(async ([channelId, entry]) => { await this.retireEntry(channelId, entry, 'relay-disconnected') }))
  }

  /**
   * Close the relay and every channel, for example when the switch turns off.
   * @returns after every adapter closed; repeating it is allowed.
   */
  async close(): Promise<void> {
    await this.disconnected()
  }

  /** Start one adapter for an envelope the Hub sent. */
  private openChannel(channelId: string, nodeId: string): void {
    if (this.channels.has(channelId)) {
      this.options.log?.(`relay: duplicate open for channel ${channelId}`)
      return
    }
    if (nodeId !== this.options.deviceId) {
      this.options.log?.('relay: refused open for a different node')
      this.options.send(JSON.stringify({ v: RELAY_VERSION, type: 'close', channelId, code: 'node-not-found', reason: 'node mismatch' }))
      return
    }
    if (this.channels.size >= MAX_CHANNELS) {
      this.options.send(JSON.stringify({ v: RELAY_VERSION, type: 'close', channelId, code: 'node-busy', reason: 'too many channels' }))
      return
    }
    this.generation += 1
    const generation = this.generation
    const entry: ChannelEntry = {
      adapter: this.createAdapter(channelId, nodeId, generation),
      generation,
      tail: Promise.resolve(),
      pending: 0,
      cancelled: false,
    }
    // The factory answers the phone itself on failure; this second consumer keeps the
    // rejection from surfacing as an unhandled one when no frame ever arrives.
    void entry.adapter.catch(() => undefined)
    this.channels.set(channelId, entry)
  }

  /** Create one adapter; a factory that fails answers the phone once. */
  private async createAdapter(channelId: string, nodeId: string, generation: number): Promise<RelayAdapter> {
    try {
      return await this.options.adapter({ channelId, nodeId })
    } catch (error) {
      const entry = this.channels.get(channelId)
      if (entry !== undefined && entry.generation === generation) {
        this.channels.delete(channelId)
        // The relay envelope only carries hello/open/frame/close; a bare `bye` would
        // be an invalid relay frame and the Hub would drop the whole socket.
        this.options.send(JSON.stringify({
          v: RELAY_VERSION,
          type: 'close',
          channelId,
          code: 'adapter-unavailable',
          reason: `adapter failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
        }))
      }
      throw error
    }
  }

  /** Deliver one frame to a channel: queued behind the previous one, bounded. */
  private forward(channelId: string, entry: ChannelEntry, payload: { readonly requestId?: string }): void {
    const send = this.sinkFor(channelId, entry.generation)
    if (entry.pending >= MAX_PENDING_FRAMES) {
      // Answer the phone instead of growing an unbounded backlog: a dropped frame the
      // Hub still counts as delivered would leave it waiting forever.
      this.options.send(JSON.stringify({
        v: RELAY_VERSION,
        type: 'frame',
        channelId,
        payload: JSON.parse(errorEnvelope(payload, 'internal', 'the desktop is busy with earlier frames')),
      }))
      return
    }
    entry.pending += 1
    entry.tail = entry.tail.then(async () => {
      try {
        if (entry.cancelled || this.channels.get(channelId)?.generation !== entry.generation) return
        const adapter = await entry.adapter
        if (entry.cancelled || this.channels.get(channelId)?.generation !== entry.generation) return
        await adapter.dispatch(payload, send)
      } catch (error) {
        // A failure the phone can attribute to its request, never a silent drop.
        this.options.send(JSON.stringify({
          v: RELAY_VERSION,
          type: 'frame',
          channelId,
          payload: JSON.parse(errorEnvelope(payload, 'internal', (error instanceof Error ? error.message : String(error)).slice(0, 300))),
        }))
      } finally {
        entry.pending -= 1
      }
    })
  }

  /**
   * Build the answer writer for one channel generation. A callback that outlives its
   * channel — or belongs to an earlier adapter for the same id — writes nothing.
   */
  private sinkFor(channelId: string, generation: number): (payload: unknown) => void {
    return (payload) => {
      if (this.closed) return
      const current = this.channels.get(channelId)
      if (current === undefined || current.generation !== generation) return
      this.options.send(JSON.stringify({ v: RELAY_VERSION, type: 'frame', channelId, payload }))
    }
  }

  /** Close one channel and forget it. */
  private async retire(channelId: string, entry: ChannelEntry, reason: string): Promise<void> {
    this.channels.delete(channelId)
    await this.retireEntry(channelId, entry, reason)
  }

  /** Close one already-forgotten channel's adapter exactly once. */
  private async retireEntry(channelId: string, entry: ChannelEntry, reason: string): Promise<void> {
    entry.cancelled = true
    try {
      const adapter = await entry.adapter
      await adapter.close()
    } catch (error) {
      this.options.log?.(`relay: closing channel ${channelId} (${reason}) failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
