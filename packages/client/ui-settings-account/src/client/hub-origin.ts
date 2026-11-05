/**
 * The account card's Hub address row.
 *
 * An installed client can be pointed at another Hub without rebuilding it: the
 * connector validates the address, and a real move signs the current account out
 * before the new address is stored. The row reads and writes the connector's own
 * `hub-connector/api` routes; a plain browser or a build without a connector
 * answers 404, and the first 404 stops the polling for good.
 */

/** Route serving the connector status document. */
const STATE_ROUTE = '/hub-connector/api/state'

/** Route accepting a settings patch; an empty `hubOrigin` restores the build-time origin. */
const SETTINGS_ROUTE = '/hub-connector/api/settings'

/** How often the status route is read while the card is open. */
const DEFAULT_INTERVAL_MS = 15_000

/** Login phases during which the connector refuses to move the address. */
const ACTIVE_LOGIN_PHASES: readonly string[] = ['initializing', 'waiting-browser', 'exchanging', 'committing']

/** One read of the connector's Hub-address state, as the card renders it. */
export interface HubOriginSnapshot {
  /** Address every Hub request uses now. */
  readonly origin: string
  /** Address this build carries; what "restore default" returns to. */
  readonly builtOrigin: string
  /** Address the user entered, or '' while this install follows the build. */
  readonly override: string
  /** Whether a device token is stored, which decides the confirmation copy. */
  readonly signedIn: boolean
  /** Whether a login attempt is in flight, which disables the change. */
  readonly signingIn: boolean
}

/** Outcome of one requested address change. */
export type HubOriginChangeResult =
  | { readonly status: 'changed'; readonly snapshot: HubOriginSnapshot }
  | { readonly status: 'invalid-origin' }
  | { readonly status: 'sign-in-in-progress' }
  | { readonly status: 'failed' }

/** Collaborators the watcher reaches outside itself. */
export interface HubOriginWatcherOptions {
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
 * Read the address fields of a connector status document.
 * @param value - Parsed status body.
 * @returns The snapshot, or undefined when this document serves no address (no connector, or no built origin).
 */
export function parseHubOrigin(value: unknown): HubOriginSnapshot | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const origin = record.hubOrigin
  const builtOrigin = record.builtHubOrigin
  if (typeof origin !== 'string' || typeof builtOrigin !== 'string') return undefined
  // Without an effective address there is nothing to show or change; an older
  // connector that never reported the override reads as "follows the build".
  if (origin === '') return undefined
  const phase = record.loginPhase
  return {
    origin,
    builtOrigin,
    override: typeof record.hubOriginOverride === 'string' ? record.hubOriginOverride : '',
    signedIn: record.signedIn === true,
    signingIn: typeof phase === 'string' && ACTIVE_LOGIN_PHASES.includes(phase),
  }
}

/**
 * Watch the connector's Hub address and submit changes to it.
 *
 * A 401, 403, or 404 means this build has no connector, so the card renders no row.
 */
export class HubOriginWatcher {
  private timer: ReturnType<typeof setInterval> | undefined
  private reading = false
  private stopped = false
  private last: string | undefined

  /**
   * @param onChange - Receives the snapshot, or undefined when this build has no connector.
   * @param options - Origin, poll interval, HTTP client, and diagnostics.
   */
  constructor(
    private readonly onChange: (snapshot: HubOriginSnapshot | undefined) => void,
    private readonly options: HubOriginWatcherOptions = {},
  ) {}

  /** Read once and keep polling until {@link dispose}. */
  start(): void {
    if (this.stopped || this.timer !== undefined) return
    void this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
  }

  /** Stop polling and ignore a read that is still in flight. */
  dispose(): void {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Read the status route once.
   * @returns after the snapshot was published, or after a failed read was reported.
   */
  async refresh(): Promise<void> {
    if (this.reading || this.stopped) return
    this.reading = true
    try {
      const response = await this.request(STATE_ROUTE)
      if (response === undefined) return
      if (!response.ok) return
      this.publish(parseHubOrigin(await response.json()))
    } catch (error) {
      this.options.onError?.(error)
    } finally {
      this.reading = false
    }
  }

  /**
   * Ask the connector to store one address.
   * @param value - Address the user entered; an empty string restores the build-time origin.
   * @returns What the connector answered, and the new snapshot when it accepted the change.
   */
  async change(value: string): Promise<HubOriginChangeResult> {
    if (this.stopped) return { status: 'failed' }
    try {
      const response = await this.request(SETTINGS_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ hubOrigin: value }),
      })
      if (response === undefined) return { status: 'failed' }
      if (response.status === 409) return { status: 'sign-in-in-progress' }
      if (response.status === 400) {
        const reason = (await response.json() as { readonly error?: unknown }).error
        return { status: reason === 'invalid-origin' ? 'invalid-origin' : 'failed' }
      }
      if (!response.ok) return { status: 'failed' }
      const snapshot = parseHubOrigin(await response.json())
      if (snapshot === undefined) return { status: 'failed' }
      this.publish(snapshot)
      return { status: 'changed', snapshot }
    } catch (error) {
      this.options.onError?.(error)
      return { status: 'failed' }
    }
  }

  /**
   * Ask one connector route, stopping the poll when this build has no connector.
   * @param path - Route below the origin.
   * @param init - Optional request fields.
   * @returns The response, or undefined when the row does not apply here.
   */
  private async request(path: string, init?: RequestInit): Promise<Response | undefined> {
    if (this.stopped) return undefined
    const origin = this.options.origin ?? (typeof globalThis.location === 'undefined' ? '' : globalThis.location.origin)
    const fetchImpl = this.options.fetch ?? globalThis.fetch
    const response = await fetchImpl(`${origin}${path}`, { ...init, cache: 'no-store' })
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      this.dispose()
      this.publish(undefined)
      return undefined
    }
    return response
  }

  /** Publish a snapshot unless it repeats the previous one. */
  private publish(snapshot: HubOriginSnapshot | undefined): void {
    const key = snapshot === undefined ? 'none' : JSON.stringify(snapshot)
    if (key === this.last) return
    this.last = key
    this.onChange(snapshot)
  }
}
