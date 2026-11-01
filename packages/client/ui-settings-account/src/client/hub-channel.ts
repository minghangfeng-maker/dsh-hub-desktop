/**
 * The account card's phone-access switch and connection status.
 *
 * The switch belongs to this computer, so the card reads and writes the
 * connector's own `hub-connector/api/channel` route: a plain browser has no
 * connector and the first 404 stops the polling for good. The document carries no
 * credential, and nothing here can open a connection by itself — the Host owns the
 * outbound channel and reports the phase it reached.
 */

/** Route serving the switch and its status. */
const CHANNEL_ROUTE = '/hub-connector/api/channel'

/** How often the route is read while the card is open. */
const DEFAULT_INTERVAL_MS = 15_000

/** Connection phases the Host reports. */
export type HubChannelPhase = 'off' | 'waiting-sign-in' | 'connecting' | 'online' | 'retry' | 'failed'

/** One read of the channel state, as the card renders it. */
export interface HubChannelSnapshot {
  /** Whether this computer's user turned phone access on. */
  readonly enabled: boolean
  /** Where the connection stands. */
  readonly phase: HubChannelPhase
  /** Machine-readable reason for the phase. */
  readonly detail: string
  /** Bound Hub account, or null before the first sign-in. */
  readonly account: string | null
  /** Bound device identity, or null. */
  readonly nodeId: string | null
  /** When the current connection was established, ISO-8601. */
  readonly connectedAt: string | null
}

/** Collaborators the watcher reaches outside itself. */
export interface HubChannelWatcherOptions {
  /** Origin serving the connector routes; the document's own origin by default. */
  readonly origin?: string
  /** Poll interval in milliseconds. */
  readonly intervalMs?: number
  /** HTTP client, replaced in tests. */
  readonly fetch?: typeof globalThis.fetch
  /** Diagnostic sink for a failed read. */
  readonly onError?: (error: unknown) => void
}

/** Phases this client understands; anything else reads as `failed`. */
const PHASES: readonly HubChannelPhase[] = ['off', 'waiting-sign-in', 'connecting', 'online', 'retry', 'failed']

/**
 * Read one channel document without trusting the response.
 * @param value - parsed JSON body.
 * @returns the snapshot, or undefined when the body is not a channel document.
 */
export function parseHubChannel(value: unknown): HubChannelSnapshot | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.enabled !== 'boolean') return undefined
  const phase = PHASES.find(candidate => candidate === record.phase)
  if (phase === undefined) return undefined
  const text = (field: unknown): string => typeof field === 'string' ? field : ''
  const nullable = (field: unknown): string | null => typeof field === 'string' && field !== '' ? field : null
  return {
    enabled: record.enabled,
    phase,
    detail: text(record.detail),
    account: nullable(record.account),
    nodeId: nullable(record.nodeId),
    connectedAt: nullable(record.connectedAt),
  }
}

/**
 * Poll the switch and publish each change.
 *
 * A 401, 403, or 404 means this build has no phone channel (a plain browser, or
 * an older desktop), so the card simply renders no row.
 */
export class HubChannelWatcher {
  private readonly onChange: (snapshot: HubChannelSnapshot | undefined) => void
  private readonly options: HubChannelWatcherOptions
  private timer: ReturnType<typeof setInterval> | undefined
  private reading = false
  private stopped = false
  private last: string | undefined

  /**
   * @param onChange - receives the snapshot, or undefined when this build has no channel.
   * @param options - origin, poll interval, HTTP client, and diagnostics.
   */
  constructor(onChange: (snapshot: HubChannelSnapshot | undefined) => void, options: HubChannelWatcherOptions = {}) {
    this.onChange = onChange
    this.options = options
  }

  /** Read once and keep polling until {@link dispose}. */
  start(): void {
    if (this.stopped || this.timer !== undefined) return
    void this.read()
    this.timer = setInterval(() => { void this.read() }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
  }

  /** Stop polling and release the interval. */
  dispose(): void {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Turn phone access on or off and publish the Host's answer.
   * @param enabled - requested switch position.
   * @returns after the Host answered.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.stopped) return
    const response = await this.request(CHANNEL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    if (response === undefined) return
    const snapshot = parseHubChannel(await response.json())
    if (snapshot !== undefined) this.publish(snapshot)
  }

  /** Read the route once. */
  private async read(): Promise<void> {
    if (this.stopped || this.reading) return
    this.reading = true
    try {
      const response = await this.request(CHANNEL_ROUTE)
      if (response === undefined) return
      const snapshot = parseHubChannel(await response.json())
      if (snapshot !== undefined) this.publish(snapshot)
    } catch (error) {
      this.options.onError?.(error)
    } finally {
      this.reading = false
    }
  }

  /**
   * Ask the route once, stopping the poll when this build has no channel.
   * @param path - route below the origin.
   * @param init - optional request fields.
   * @returns the response, or undefined when the row does not apply here.
   */
  private async request(path: string, init?: RequestInit): Promise<Response | undefined> {
    const origin = this.options.origin ?? (typeof globalThis.location === 'undefined' ? '' : globalThis.location.origin)
    const fetchImpl = this.options.fetch ?? globalThis.fetch
    const response = await fetchImpl(`${origin}${path}`, { ...init, cache: 'no-store' })
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      this.dispose()
      this.publish(undefined)
      return undefined
    }
    if (!response.ok) throw new Error(`hub channel route answered ${String(response.status)}`)
    return response
  }

  /** Publish a snapshot unless it repeats the previous one. */
  private publish(snapshot: HubChannelSnapshot | undefined): void {
    const key = snapshot === undefined ? 'none' : JSON.stringify(snapshot)
    if (key === this.last) return
    this.last = key
    this.onChange(snapshot)
  }
}
