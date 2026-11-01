/**
 * The Hub connector's pending restart, as the account card shows it.
 *
 * A Hub manifest that changes the profile overlay only takes effect at the next
 * start, and only the desktop shell can restart the application. The connector
 * records the need in its own state and accepts a restart request, both on its
 * `hub-connector/api` routes; this module is the account card's side of those two
 * routes. A plain browser has neither route, so the first 404 stops the polling for
 * good instead of repeating a request that cannot succeed.
 */

/** Route the connector serves its status from. */
const STATE_ROUTE = '/hub-connector/api/state'

/** Route that records a restart request for the desktop shell. */
const RESTART_ROUTE = '/hub-connector/api/restart'

/** How often the state route is read while the client runs. */
const DEFAULT_INTERVAL_MS = 15_000

/** Collaborators the watcher reaches outside itself. */
export interface HubRestartWatcherOptions {
  /** Origin serving the connector routes; the document's own origin by default. */
  readonly origin?: string
  /** Poll interval in milliseconds. */
  readonly intervalMs?: number
  /** HTTP client, replaced in tests. */
  readonly fetch?: typeof globalThis.fetch
  /** Diagnostic sink for a failed read. */
  readonly onError?: (error: unknown) => void
}

/**
 * Report whether a connector status document carries a pending restart.
 * @param value - Parsed status body.
 * @returns Whether the connector recorded a restart the application still owes.
 */
export function pendingHubRestart(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const restart = (value as { restart?: unknown }).restart
  return typeof restart === 'object' && restart !== null
}

/**
 * Watch the connector's restart record and offer the restart action.
 *
 * The card reads the record rather than the shell's prompt state, so a user who
 * dismissed the prompt still finds the row here for the rest of the run.
 */
export class HubRestartWatcher {
  private timer: ReturnType<typeof setInterval> | undefined
  private pending = false
  private reading = false
  private stopped = false

  /**
   * @param onChange - Called when the pending flag changes.
   * @param options - Origin, poll interval, HTTP client, and diagnostics.
   */
  constructor(
    private readonly onChange: (pending: boolean) => void,
    private readonly options: HubRestartWatcherOptions = {},
  ) {}

  /** Begin polling; the first read runs immediately. */
  start(): void {
    if (this.timer !== undefined || this.stopped) return
    this.timer = setInterval(() => { void this.refresh() }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
    void this.refresh()
  }

  /** Stop polling and ignore a read that is still in flight. */
  dispose(): void {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Read the connector status once.
   * @returns after the pending flag was published, or after a failed read was reported.
   */
  async refresh(): Promise<void> {
    if (this.reading || this.stopped) return
    this.reading = true
    try {
      const response = await this.request(STATE_ROUTE, 'GET')
      if (response === undefined) return
      if (response.status === 404) {
        // A plain Web client has no connector; asking again cannot change that.
        this.dispose()
        this.publish(false)
        return
      }
      if (!response.ok) return
      this.publish(pendingHubRestart(await response.json() as unknown))
    } catch (error) {
      this.options.onError?.(error)
    } finally {
      this.reading = false
    }
  }

  /**
   * Ask the desktop shell for the pending restart.
   * @returns Whether the connector accepted the request.
   */
  async requestRestart(): Promise<boolean> {
    try {
      const response = await this.request(RESTART_ROUTE, 'POST')
      if (response === undefined) return false
      if (response.status === 404) {
        this.dispose()
        return false
      }
      return response.ok
    } catch (error) {
      this.options.onError?.(error)
      return false
    }
  }

  private async request(route: string, method: 'GET' | 'POST'): Promise<Response | undefined> {
    if (this.stopped) return undefined
    const origin = this.options.origin ?? window.location.origin
    const fetchImpl = this.options.fetch ?? globalThis.fetch
    return await fetchImpl(`${origin}${route}`, {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
  }

  private publish(pending: boolean): void {
    if (this.stopped || pending === this.pending) return
    this.pending = pending
    this.onChange(pending)
  }
}
