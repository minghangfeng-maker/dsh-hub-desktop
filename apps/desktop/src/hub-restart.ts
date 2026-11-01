/**
 * The Hub restart notice: what the connector recorded, and what the shell does about it.
 *
 * The connector applies Hub manifests inside the Host, so it is the only place that
 * knows the overlay it just wrote takes effect at the next start — but it cannot
 * restart the application. It writes that record into
 * `<profile>/desktop-hub/state.json`, together with the end of the sync round that
 * produced it and an optional request from the account page, and this module is the
 * shell's side of the same file: a watcher that turns the record into one prompt, or
 * into the restart the account page asked for.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Seconds between reads of the connector state file. */
const POLL_INTERVAL_MS = 2000

/** Connector state file below the desktop profile. */
const STATE_PATH = join('desktop-hub', 'state.json')

/** The pending restart, narrowed to the members the shell acts on. */
export interface HubRestartRecord {
  /** Operator sentence naming what needs the restart. */
  readonly reason: string
  /** When the need was recorded, ISO-8601. */
  readonly at: string
  /** Host process that wrote the record. */
  readonly boot: string
  /** Set when the account page asked the shell to restart. */
  readonly requestedAt?: string
}

/** What one read of the connector state says about restarting. */
export interface HubRestartSnapshot {
  /** Pending restart, when the connector recorded one. */
  readonly restart: HubRestartRecord | null
  /** When the last sync round settled; null before the first one. */
  readonly syncedAt: string | null
}

/** What the shell already did about this connector state. */
export interface HubRestartMemory {
  /** When this application run started; a record written before it came from an earlier run. */
  readonly since: string
  /** `at` of the record the user was already prompted for; a dismissal counts. */
  readonly promptAt: string | null
  /** `requestedAt` the shell already performed. */
  readonly requestAt: string | null
}

/** One decision per read. */
export type HubRestartAction =
  | { readonly kind: 'idle' }
  | { readonly kind: 'prompt'; readonly restart: HubRestartRecord }
  | { readonly kind: 'restart'; readonly restart: HubRestartRecord }

/** Narrow an unknown value to a plain record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read one optional string member. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Whether an ISO-8601 timestamp is at or after another; an unparsable one never is. */
function atOrAfter(value: string, reference: string): boolean {
  const left = Date.parse(value)
  const right = Date.parse(reference)
  return Number.isFinite(left) && Number.isFinite(right) && left >= right
}

/**
 * Read the connector's pending restart from one state document.
 * @param profile - Desktop profile directory.
 * @returns The record and the last sync round, or undefined when the file is absent or unreadable.
 */
export function readHubRestartSnapshot(profile: string): HubRestartSnapshot | undefined {
  const path = join(profile, STATE_PATH)
  if (!existsSync(path)) return undefined
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    // A half-written or hand-edited file is not a restart request; the next poll rereads it.
    return undefined
  }
  const root = record(value)
  if (root === undefined) return undefined
  const restart = record(root.restart)
  const reason = text(restart?.reason)
  const at = text(restart?.at)
  const boot = text(restart?.boot)
  const requestedAt = text(restart?.requestedAt)
  return {
    restart: reason === undefined || at === undefined || boot === undefined
      ? null
      : { reason, at, boot, ...requestedAt === undefined ? {} : { requestedAt } },
    syncedAt: text(root.syncedAt) ?? null,
  }
}

/**
 * Choose what one snapshot implies.
 *
 * A restart is only offered after the sync round that produced it settled: the
 * dependency pass may still be reloading the composition, and a user who restarts
 * into that state would repeat the round. A request from the account page waits for
 * the same point, then restarts without another prompt.
 *
 * A record written before this application run is ignored: the Host that composes
 * the overlay at this start already satisfies it, and the connector retires it a
 * moment later — prompting first would offer a restart that changed nothing.
 * @param snapshot - Connector state read from the profile.
 * @param memory - When this run started, and what the shell already offered or performed.
 * @returns The action to take now.
 */
export function decideHubRestart(snapshot: HubRestartSnapshot, memory: HubRestartMemory): HubRestartAction {
  const restart = snapshot.restart
  if (restart === null) return { kind: 'idle' }
  if (!atOrAfter(restart.at, memory.since)) return { kind: 'idle' }
  const settled = snapshot.syncedAt !== null && atOrAfter(snapshot.syncedAt, restart.at)
  if (!settled) return { kind: 'idle' }
  if (restart.requestedAt !== undefined && restart.requestedAt !== memory.requestAt) return { kind: 'restart', restart }
  if (memory.promptAt === restart.at) return { kind: 'idle' }
  return { kind: 'prompt', restart }
}

/** Main-process collaborators of the watcher. */
export interface DesktopHubRestartWatcherOptions {
  /** Desktop profile directory holding the connector state. */
  readonly profile: string
  /** When this application run started; records older than it belong to an earlier run. */
  readonly since: string
  /**
   * Show the restart prompt and, when the user picks it, perform the restart.
   * @param reason - Operator sentence the connector recorded.
   * @returns Whether the prompt was actually shown; false retries on the next read.
   */
  readonly prompt: (reason: string) => Promise<boolean>
  /** Perform a restart the account page asked for. */
  readonly restart: () => Promise<void>
  /** Read one snapshot; replaced in tests. */
  readonly read?: ((profile: string) => HubRestartSnapshot | undefined) | undefined
  /** Poll interval in milliseconds. */
  readonly intervalMs?: number | undefined
  /** Diagnostic sink for a watcher that could not decide. */
  readonly onError?: ((error: unknown) => void) | undefined
}

/**
 * Watches the connector state file and offers the restart it asks for.
 *
 * One prompt per recorded restart: a dismissal is remembered in memory, so a user
 * who picks "later" is not asked again in this run and still has the row in the
 * account card. A restart clears the record itself, because the next Host start
 * composes the overlay the notice referred to.
 */
export class DesktopHubRestartWatcher {
  private timer: ReturnType<typeof setInterval> | undefined
  private polling = false
  private promptAt: string | null = null
  private requestAt: string | null = null

  /** @param options - Profile, prompt and restart actions, and the poll interval. */
  constructor(private readonly options: DesktopHubRestartWatcherOptions) {}

  /** Begin polling; the first read runs immediately. */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => { void this.poll() }, this.options.intervalMs ?? POLL_INTERVAL_MS)
    this.timer.unref()
    void this.poll()
  }

  /** Stop polling; an in-flight decision still finishes. */
  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Read once and act on the decision. */
  private async poll(): Promise<void> {
    if (this.polling) return
    const snapshot = (this.options.read ?? readHubRestartSnapshot)(this.options.profile)
    if (snapshot === undefined) return
    const action = decideHubRestart(snapshot, {
      since: this.options.since, promptAt: this.promptAt, requestAt: this.requestAt,
    })
    if (action.kind === 'idle') return
    this.polling = true
    try {
      if (action.kind === 'restart') {
        this.requestAt = action.restart.requestedAt ?? null
        await this.options.restart()
        return
      }
      // A prompt that found no window returns false, so the next poll tries again;
      // one the user answered — either button — is not repeated for this record.
      if (await this.options.prompt(action.restart.reason)) this.promptAt = action.restart.at
    } catch (error) {
      this.options.onError?.(error)
    } finally {
      this.polling = false
    }
  }
}
