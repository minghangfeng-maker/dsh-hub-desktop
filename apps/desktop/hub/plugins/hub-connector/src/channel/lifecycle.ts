/**
 * Lifetime of the outbound channel: at most one socket, retried on its own
 * schedule, and never opened while the local switch is off or the account is
 * unbound.
 *
 * Frames are opaque here. A connection's socket surface and the frame sink are
 * separate seams so the mobile BFF protocol (owned elsewhere) can be attached
 * without changing this state machine, and so a test can drive connections
 * without a network.
 */

import { retryAt, retryDelay } from './backoff.ts'
import { closeReasonOf } from './transport.ts'
import type {
  ChannelCredentials,
  ChannelPhase,
  ChannelSocket,
  ChannelStatus,
  ChannelTransport,
} from './types.ts'

/** Build one status document from the lifecycle's current facts. */
function statusDocument(input: {
  readonly enabled: boolean
  readonly phase: ChannelPhase
  readonly detail: string
  readonly credentials: ChannelCredentials | undefined
  readonly connectedAt: string | null
  readonly attempts: number
  readonly nextRetryAt: string | null
}): ChannelStatus {
  return {
    enabled: input.enabled,
    phase: input.phase,
    detail: input.detail,
    nodeId: input.credentials?.nodeId ?? null,
    account: input.credentials?.username ?? null,
    connectedAt: input.connectedAt,
    attempts: input.attempts,
    nextRetryAt: input.nextRetryAt,
  }
}

/** Collaborators the lifetime reaches outside itself. */
export interface ChannelLifecycleOptions {
  /** Where sockets come from. */
  readonly transport: ChannelTransport
  /** Clock, replaced in tests. */
  readonly now: () => Date
  /** Uniform value in `[0, 1)`, replaced in tests. */
  readonly random: () => number
  /**
   * Arm one delayed callback.
   * @returns canceller for the armed callback.
   */
  readonly schedule?: (delayMs: number, run: () => void) => () => void
  /** Receives every status the lifetime settles on. */
  readonly onChange?: (status: ChannelStatus) => void
}

/**
 * One connection's lifetime.
 *
 * A socket is open only in {@link ChannelPhase.online}; every other phase either
 * owns no socket or is between a close and its retry.
 */
export class ChannelLifecycle {
  private readonly transport: ChannelTransport
  private readonly now: () => Date
  private readonly random: () => number
  private readonly schedule: (delayMs: number, run: () => void) => () => void
  private readonly listeners = new Set<(status: ChannelStatus) => void>()
  private readonly frameSinks = new Set<(text: string) => void>()
  private credentials: ChannelCredentials | undefined
  private enabled = false
  private disposed = false
  private phase: ChannelPhase = 'off'
  private detail = 'user-disabled'
  private attempts = 0
  private connectedAt: string | null = null
  private nextRetryAt: string | null = null
  private socket: ChannelSocket | undefined
  private detachClose: (() => void) | undefined
  private detachMessage: (() => void) | undefined
  private cancelRetry: (() => void) | undefined
  private opening: AbortController | undefined
  private generation = 0
  private lastEmitted = ''

  /**
   * @param options - transport, clock, jitter source, scheduler, and status listener.
   */
  constructor(options: ChannelLifecycleOptions) {
    this.transport = options.transport
    this.now = options.now
    this.random = options.random
    this.schedule = options.schedule ?? ((delayMs, run) => {
      const timer = setTimeout(run, delayMs)
      timer.unref?.()
      return () => { clearTimeout(timer) }
    })
    if (options.onChange !== undefined) this.listeners.add(options.onChange)
  }

  /** @returns the status the local surface renders. */
  status(): ChannelStatus {
    return statusDocument({
      enabled: this.enabled,
      phase: this.phase,
      detail: this.detail,
      credentials: this.credentials,
      connectedAt: this.connectedAt,
      attempts: this.attempts,
      nextRetryAt: this.nextRetryAt,
    })
  }

  /**
   * @param listener - status recipient.
   * @returns disposer removing the listener.
   */
  onChange(listener: (status: ChannelStatus) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Attach the frame consumer, which must tolerate frames arriving before it reads them.
   * @param listener - receives every frame of the current and later connections.
   * @returns disposer removing the listener.
   */
  attachFrames(listener: (text: string) => void): () => void {
    this.frameSinks.add(listener)
    return () => { this.frameSinks.delete(listener) }
  }

  /**
   * Send one frame on the current connection.
   * @param text - complete frame text.
   * @returns whether a connected socket accepted it.
   */
  send(text: string): boolean {
    if (this.socket === undefined || this.phase !== 'online') return false
    this.socket.send(text)
    return true
  }

  /**
   * Turn the channel on or off. Turning it off closes the socket and cancels a
   * pending retry; turning it on connects only when an account is bound.
   * @param enabled - requested switch position.
   */
  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return
    this.enabled = enabled
    this.attempts = 0
    this.nextRetryAt = null
    if (!enabled) {
      this.cancelTimer()
      this.closeSocket('user-disabled')
      this.setPhase('off', 'user-disabled')
      return
    }
    if (this.credentials === undefined) {
      this.setPhase('waiting-sign-in', 'signed-out')
      return
    }
    void this.connect()
  }

  /**
   * Replace the credentials the channel connects with. A different node, account,
   * or origin ends the current connection before the next one opens; no credentials
   * ends it without scheduling a retry.
   * @param credentials - current grant facts, or undefined after a sign-out.
   */
  setCredentials(credentials: ChannelCredentials | undefined): void {
    if (this.disposed) return
    const previous = this.credentials
    this.credentials = credentials
    const changed = previous === undefined || credentials === undefined
      || previous.nodeId !== credentials.nodeId
      || previous.username !== credentials.username
      || previous.hubOrigin !== credentials.hubOrigin
      || previous.token !== credentials.token
    if (!changed) return
    this.attempts = 0
    this.nextRetryAt = null
    this.cancelTimer()
    if (credentials === undefined) {
      this.closeSocket('signed-out')
      this.connectedAt = null
      if (this.enabled) this.setPhase('waiting-sign-in', 'signed-out')
      else this.setPhase('off', 'user-disabled')
      return
    }
    this.closeSocket('credentials-changed')
    if (!this.enabled) {
      this.setPhase('off', 'user-disabled')
      return
    }
    void this.connect()
  }

  /** Retry immediately, cancelling a pending schedule. */
  retryNow(): void {
    if (this.disposed || !this.enabled || this.credentials === undefined) return
    this.cancelTimer()
    this.attempts = 0
    void this.connect()
  }

  /** Close the socket, cancel every timer, and stop accepting changes. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.enabled = false
    this.cancelTimer()
    this.closeSocket('disposed')
    this.credentials = undefined
    this.connectedAt = null
    this.phase = 'off'
    this.detail = 'disposed'
    this.listeners.clear()
    this.frameSinks.clear()
  }

  /** Publish the current status when it differs from the last one published. */
  private emit(): void {
    const status = this.status()
    const key = JSON.stringify(status)
    if (key === this.lastEmitted) return
    this.lastEmitted = key
    for (const listener of [...this.listeners]) listener(status)
  }

  /** Set the phase and publish. */
  private setPhase(phase: ChannelPhase, detail: string): void {
    this.phase = phase
    this.detail = detail
    this.emit()
  }

  /** Cancel a pending retry. */
  private cancelTimer(): void {
    if (this.cancelRetry === undefined) return
    this.cancelRetry()
    this.cancelRetry = undefined
    this.nextRetryAt = null
  }

  /** Detach and close the current socket, if any. */
  private closeSocket(reason: string): void {
    this.opening?.abort()
    this.opening = undefined
    const socket = this.socket
    this.socket = undefined
    this.detachClose?.()
    this.detachMessage?.()
    this.detachClose = undefined
    this.detachMessage = undefined
    if (socket === undefined) return
    this.generation += 1
    try {
      socket.close(reason)
    } catch {
      // A socket that is already closing has nothing left to release.
    }
  }

  /** Arm one retry after the current attempt count. */
  private scheduleRetry(detail: string): void {
    const delay = retryDelay(this.attempts - 1, this.random())
    this.nextRetryAt = retryAt(this.now(), delay)
    this.setPhase('retry', detail)
    this.cancelRetry = this.schedule(delay, () => {
      this.cancelRetry = undefined
      this.nextRetryAt = null
      void this.connect()
    })
  }

  /** Open one connection attempt and wire its lifetime. */
  private async connect(): Promise<void> {
    if (this.disposed || !this.enabled || this.credentials === undefined) return
    this.cancelTimer()
    this.closeSocket('reconnect')
    this.generation += 1
    const generation = this.generation
    const controller = new AbortController()
    this.opening = controller
    this.setPhase('connecting', 'connecting')
    let socket: ChannelSocket
    try {
      socket = await this.transport.open({ credentials: this.credentials, signal: controller.signal })
    } catch (error) {
      if (generation !== this.generation || this.disposed || !this.enabled) return
      this.opening = undefined
      this.attempts += 1
      const code = error instanceof Error && 'code' in error ? String(Reflect.get(error, 'code')) : 'open-failed'
      if (code === 'transport-unavailable') {
        this.setPhase('failed', 'transport-unavailable')
        return
      }
      if (code === 'cancelled') {
        this.setPhase('off', 'cancelled')
        return
      }
      this.scheduleRetry('open-failed')
      return
    }
    this.opening = undefined
    if (generation !== this.generation || this.disposed || !this.enabled) {
      socket.close('superseded')
      return
    }
    this.socket = socket
    this.attempts = 0
    this.connectedAt = this.now().toISOString()
    this.detachMessage = socket.onMessage((text) => {
      for (const sink of [...this.frameSinks]) sink(text)
    })
    this.detachClose = socket.onClose((event) => {
      if (generation !== this.generation) return
      this.socket = undefined
      this.detachClose = undefined
      this.detachMessage?.()
      this.detachMessage = undefined
      this.connectedAt = null
      if (this.disposed || !this.enabled) {
        this.setPhase('off', 'user-disabled')
        return
      }
      this.attempts += 1
      this.scheduleRetry(closeReasonOf(event))
    })
    this.setPhase('online', 'connected')
  }
}
