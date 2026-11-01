/**
 * The outbound phone-access channel: local switch, account binding, and the
 * connection lifetime that will carry the mobile BFF frames once that protocol
 * is frozen.
 *
 * The switch and the binding are user-owned local state; nothing here sends
 * session content anywhere, and no code in this directory dials a local Host
 * address. Frames stay opaque at this layer: a transport moves text, and the
 * BFF adapter (owned separately) is the only party that interprets them.
 */

/** The local switch the machine's user owns. Remote access is off unless it is on. */
export type ChannelSwitch = 'on' | 'off'

/**
 * The Hub account and node this machine was bound to when the switch was turned
 * on. A binding that no longer matches the stored grant stops the channel
 * instead of reconnecting into a different account.
 */
export interface ChannelBinding {
  /** Hub-issued device identity this machine reported as. */
  readonly nodeId: string
  /** Hub username the device token belongs to. */
  readonly username: string
  /** Hub origin, normalized to its origin. */
  readonly hubOrigin: string
  /** When the binding was recorded, ISO-8601. */
  readonly boundAt: string
}

/** Where the channel's connection stands right now, for the local status surface. */
export type ChannelPhase =
  | 'off'
  | 'waiting-sign-in'
  | 'connecting'
  | 'online'
  | 'retry'
  | 'failed'

/** Status document the account page and the Hub device report read. */
export interface ChannelStatus {
  /** Whether the local switch is on. */
  readonly enabled: boolean
  /** Connection phase; `off` also covers a switch that is on but has nothing to reach. */
  readonly phase: ChannelPhase
  /** Short machine-readable reason for the phase, for logs and diagnostics. */
  readonly detail: string
  /** Bound node identity, or null before the first successful sign-in. */
  readonly nodeId: string | null
  /** Bound Hub username, or null. */
  readonly account: string | null
  /** When the current connection was established, ISO-8601. */
  readonly connectedAt: string | null
  /** Consecutive failed connection attempts since the last success. */
  readonly attempts: number
  /** When the next retry is due, ISO-8601, or null when none is scheduled. */
  readonly nextRetryAt: string | null
}

/** What one connection needs in order to reach the Hub. Never logged. */
export interface ChannelCredentials {
  /** Hub origin, normalized to its origin. */
  readonly hubOrigin: string
  /** Hub device token; the account's grant holds it. */
  readonly token: string
  /** Hub-issued device identity. */
  readonly nodeId: string
  /** Hub username the token belongs to. */
  readonly username: string
}

/** Why one socket stopped, as the transport observed it. */
export interface ChannelCloseEvent {
  /** WebSocket close code, or 0 when the transport never reached open. */
  readonly code: number
  /** Close reason text, possibly empty. */
  readonly reason: string
}

/** One open connection's frame surface. Frames are opaque text at this layer. */
export interface ChannelSocket {
  /**
   * Send one frame.
   * @param text - complete frame text.
   */
  send(text: string): void
  /**
   * Close the connection from this side.
   * @param reason - text recorded with the close.
   */
  close(reason: string): void
  /**
   * @param listener - receives every received frame.
   * @returns disposer removing the listener.
   */
  onMessage(listener: (text: string) => void): () => void
  /**
   * @param listener - receives the close event once.
   * @returns disposer removing the listener.
   */
  onClose(listener: (event: ChannelCloseEvent) => void): () => void
}

/** Where connections come from; replaced in tests with an in-memory socket. */
export interface ChannelTransport {
  /**
   * Open one connection.
   * @param request - credentials to present and a signal that aborts while connecting.
   * @returns the open socket, or a rejection the lifecycle treats as one failed attempt.
   */
  open(request: {
    readonly credentials: ChannelCredentials
    readonly signal: AbortSignal
  }): Promise<ChannelSocket>
}
