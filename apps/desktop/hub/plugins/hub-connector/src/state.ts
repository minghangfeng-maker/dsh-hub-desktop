/**
 * Local connector state the Hub never sees.
 *
 * Everything here is machine-local bookkeeping: the settings the user can
 * change, the server-issued device identity, what this device last applied, and
 * the exact body of the last device report (so the account page can show it
 * verbatim). The file lives in `<profile>/desktop-hub/state.json` — writable
 * user state, like the profile's own `package.json`, never a credential: the
 * device token and the relay keys stay in the credential store.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HubDefaultSelection } from './models.ts'

/** Directory the connector owns inside the desktop profile. */
export const HUB_STATE_DIRECTORY = 'desktop-hub'

/** State document version; a mismatch resets the file rather than guessing at old fields. */
const STATE_VERSION = 1

/** One plugin the Hub also reported as managed, kept for the status surface. */
export interface ManagedPluginRecord {
  /** npm package name. */
  readonly name: string
  /** Installed version. */
  readonly version: string
  /**
   * Where the package came from: the installer's bundled set, or the level the
   * Hub delivered it under. Maps to the report's `source`.
   */
  readonly source: 'bundled' | 'hub-core' | 'hub-default' | 'hub-optional'
  /** Whether the row is currently part of the profile's bundle list. */
  readonly enabled: boolean
}

/** Settings the user can change from the account page. */
export interface HubSettings {
  /** Hub origin override; empty means "use the build-time origin". */
  readonly hubOrigin: string
  /** User-visible device name sent with every report. */
  readonly deviceName: string
  /** Whether the DeepSeek official account entry is offered under Advanced. Reports as diagnostics only. */
  readonly deepSeekLogin: boolean
}

/** What the last manifest application achieved. */
export interface ApplyRecord {
  /** Local completion counter, including retries of the same manifest revision. */
  readonly applySequence: number
  /** Applied manifest revision, or null before the first application. */
  readonly appliedRevision: number | null
  /** When that revision finished applying, ISO-8601. */
  readonly appliedAt: string | null
  /** Outcome reported to the Hub. */
  readonly applyState: 'unknown' | 'applied' | 'partial' | 'pending' | 'failed'
  /** First failure cause, from the Hub's fixed enum. */
  readonly applyErrorCode: string | null
  /** How many entries failed. */
  readonly errorCount: number
}

/** Model routes the Hub delivered, held outside the user's own settings section. */
export interface ManagedModelRecord {
  /** Provider profiles keyed by route, as the Hub delivered them. */
  readonly providers: Record<string, unknown>
  /** Default model the Hub recommended, when the delivery named one. */
  readonly defaultSelection?: HubDefaultSelection
  /** Hub origin that delivered the set; a set from another Hub is not republished. */
  readonly origin: string
  /** Device identity the account had at delivery; another account's set is not republished. */
  readonly deviceId: string | null
}

/** The connector's whole durable state. */
export interface HubState extends ApplyRecord {
  /** Document version. */
  readonly schemaVersion: number
  /** Server-issued device id (`dv_…`); absent until the first successful login. */
  readonly deviceId: string | null
  /** Per-install random identifier the Hub hashes into its install key. */
  readonly installId: string
  /** User settings. */
  readonly settings: HubSettings
  /** Plugins the Hub delivered and this device currently carries. */
  readonly managed: readonly ManagedPluginRecord[]
  /** Removals still held by the running composition, retried after a restart. */
  readonly pendingRemovals: readonly string[]
  /**
   * Model routes the Hub delivered. The adapter registers them as a managed set,
   * so they survive a restart without a Hub round trip and never enter the
   * overlay that owns the user's editing.
   */
  readonly managedModels: ManagedModelRecord | null
  /**
   * Bundled packages a manifest explicitly uninstalled. The installer's baseline
   * would otherwise put them back on the next start, which would undo the Hub's
   * decision; a later manifest that names the package again clears the entry.
   */
  readonly bundledRemovals: readonly string[]
  /** ETag of the last manifest response, for conditional pulls. */
  readonly manifestEtag: string | null
  /** SHA-256 of the last `config.fragments` document this device applied, for local verification. */
  readonly configDigest: string | null
  /** Exact JSON body of the last device report, minus nothing. */
  readonly lastReport: unknown
  /** Why a restart is pending, when the last application needed one. */
  readonly restart: PendingRestart | null
  /**
   * When the last sync round settled: the login sync (manifest, fragments, model
   * route, search, and the background dependency pass) or one manifest application.
   * The desktop shell shows the restart prompt only once this is at or after the
   * restart's own timestamp, so a user never restarts into a half-applied profile.
   */
  readonly syncedAt: string | null
}

/** A restart this device still owes, recorded by the Host that asked for it. */
export interface PendingRestart {
  /** Operator sentence naming what needs the restart. */
  readonly reason: string
  /** When the need was recorded, ISO-8601. */
  readonly at: string
  /**
   * Identifier of the Host process that recorded it. A later Host start composed the
   * overlay this notice refers to, so loading a record from another process means the
   * restart already happened; the connector drops it instead of prompting forever.
   */
  readonly boot: string
  /** Set when the account page asked the shell to restart; the desktop shell performs it. */
  readonly requestedAt?: string
}

/**
 * Absolute state file path for one profile.
 * @param profile - Desktop profile directory.
 * @returns Path of `desktop-hub/state.json`.
 */
export function statePath(profile: string): string {
  return join(profile, HUB_STATE_DIRECTORY, 'state.json')
}

/**
 * Read a JSON object without trusting its contents.
 * @param path - File to read.
 * @returns The parsed value, or undefined when the file is absent or unreadable.
 */
export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Narrow one unknown value to a plain record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a string member, or the fallback. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Read a boolean member, or the fallback. */
function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Choose the default device name for this machine.
 * @param osLabel - Human label such as `Windows 11`.
 * @returns A name inside the Hub's 64-character, path-free, control-character-free contract.
 */
export function defaultDeviceName(osLabel: string): string {
  return `${osLabel} 上的 DSH Hub`.slice(0, 64)
}

/**
 * Build the initial state for a profile that has never run the connector.
 * @param options - Machine label and the optional Hub origin the build baked in.
 * @returns Fresh state with no device identity.
 */
export function initialState(options: { readonly osLabel: string; readonly hubOrigin: string; readonly installId: string }): HubState {
  return {
    schemaVersion: STATE_VERSION,
    deviceId: null,
    installId: options.installId,
    settings: { hubOrigin: options.hubOrigin, deviceName: defaultDeviceName(options.osLabel), deepSeekLogin: false },
    managed: [],
    managedModels: null,
    pendingRemovals: [],
    bundledRemovals: [],
    manifestEtag: null,
    configDigest: null,
    appliedRevision: null,
    applySequence: 0,
    appliedAt: null,
    applyState: 'unknown',
    applyErrorCode: null,
    errorCount: 0,
    lastReport: null,
    restart: null,
    syncedAt: null,
  }
}

/**
 * Load the state document, filling anything absent from `fallback`.
 * @param profile - Desktop profile directory.
 * @param fallback - Initial state used when the file is missing, unreadable, or from another version.
 * @returns The stored state, or the fallback.
 */
export function loadState(profile: string, fallback: HubState): HubState {
  const raw = record(readJsonFile(statePath(profile)))
  if (raw === undefined || raw.schemaVersion !== STATE_VERSION) return fallback
  const settings = record(raw.settings)
  const managed = Array.isArray(raw.managed) ? raw.managed : []
  const restart = record(raw.restart)
  return {
    schemaVersion: STATE_VERSION,
    deviceId: text(raw.deviceId) ?? null,
    installId: text(raw.installId) ?? fallback.installId,
    settings: {
      hubOrigin: text(settings?.hubOrigin) ?? fallback.settings.hubOrigin,
      deviceName: text(settings?.deviceName) ?? fallback.settings.deviceName,
      deepSeekLogin: flag(settings?.deepSeekLogin, fallback.settings.deepSeekLogin),
    },
    managed: managed.flatMap((entry) => {
      const item = record(entry)
      const name = text(item?.name)
      const version = text(item?.version)
      const source = text(item?.source)
      if (name === undefined || version === undefined) return []
      if (source !== 'bundled' && source !== 'hub-core' && source !== 'hub-default' && source !== 'hub-optional') return []
      return [{ name, version, source, enabled: flag(item?.enabled, true) }]
    }),
    managedModels: readManagedModels(record(raw.managedModels)),
    pendingRemovals: Array.isArray(raw.pendingRemovals)
      ? raw.pendingRemovals.filter((name): name is string => typeof name === 'string')
      : [],
    bundledRemovals: Array.isArray(raw.bundledRemovals)
      ? raw.bundledRemovals.filter((name): name is string => typeof name === 'string')
      : [],
    applySequence: typeof raw.applySequence === 'number' && Number.isSafeInteger(raw.applySequence) && raw.applySequence >= 0
      ? raw.applySequence : 0,
    manifestEtag: text(raw.manifestEtag) ?? null,
    configDigest: text(raw.configDigest) ?? null,
    appliedRevision: typeof raw.appliedRevision === 'number' ? raw.appliedRevision : null,
    appliedAt: text(raw.appliedAt) ?? null,
    applyState: raw.applyState === 'applied' || raw.applyState === 'partial' || raw.applyState === 'pending'
      || raw.applyState === 'failed' || raw.applyState === 'unknown' ? raw.applyState : 'unknown',
    applyErrorCode: text(raw.applyErrorCode) ?? null,
    errorCount: typeof raw.errorCount === 'number' ? raw.errorCount : 0,
    lastReport: raw.lastReport ?? null,
    restart: readRestart(restart),
    syncedAt: text(raw.syncedAt) ?? null,
  }
}

/**
 * Read the persisted Hub model set, ignoring a document this build cannot use.
 * @param value - Raw `managedModels` member of the state document.
 * @returns The routes and the recommended default, or null when absent or malformed.
 */
function readManagedModels(value: Record<string, unknown> | undefined): ManagedModelRecord | null {
  const providers = record(value?.providers)
  if (providers === undefined) return null
  const selection = record(value?.defaultSelection)
  const provider = text(selection?.provider)
  const model = text(selection?.model)
  const reasoningEffort = text(selection?.reasoningEffort)
  const origin = text(value?.origin)
  if (origin === undefined) return null
  const deviceId = text(value?.deviceId) ?? null
  return {
    providers,
    origin,
    deviceId,
    ...provider === undefined || model === undefined
      ? {}
      : { defaultSelection: { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } } },
  }
}

/**
 * Read the pending-restart record.
 * @param value - Raw `restart` member of the state document.
 * @returns The record, or null when it is absent or incomplete.
 */
function readRestart(value: Record<string, unknown> | undefined): PendingRestart | null {
  const reason = text(value?.reason)
  const at = text(value?.at)
  const boot = text(value?.boot)
  if (reason === undefined || at === undefined || boot === undefined) return null
  const requestedAt = text(value?.requestedAt)
  return { reason, at, boot, ...requestedAt === undefined ? {} : { requestedAt } }
}

/**
 * Keep the durable apply record a stale snapshot must not roll back.
 *
 * A manifest application installs a plugin and rewrites the Hub overlay, and the
 * overlay is a Loader input: the Host recomposes, which constructs this plugin
 * again while the applying instance is still running. The new instance loaded
 * `state.json` before the application finished, so it holds the pre-apply record
 * (no revision, no managed plugins). The record it writes next would erase what
 * the applying instance just committed, and the next start would report
 * "nothing applied" to the Hub.
 *
 * The file is the durable side of the record, so it wins whenever it describes a
 * later application (revision, then the local completion counter). A newer in-memory snapshot
 * still wins, and the last report is kept whichever side is newer, because the
 * account page shows it verbatim.
 * @param current - Snapshot the writer is about to persist.
 * @param stored - Snapshot the file currently holds.
 * @returns The snapshot to write.
 */
export function mergeApplyRecord(current: HubState, stored: HubState): HubState {
  const currentRevision = current.appliedRevision ?? -1
  const storedRevision = stored.appliedRevision ?? -1
  const report = newerReport(current.lastReport, stored.lastReport) ?? current.lastReport
  const base: HubState = {
    ...current,
    deviceId: current.deviceId ?? stored.deviceId,
    lastReport: report,
  }
  if (storedRevision < currentRevision
    || (storedRevision === currentRevision && stored.applySequence <= current.applySequence)) return base
  return {
    ...base,
    applySequence: stored.applySequence,
    appliedRevision: stored.appliedRevision,
    appliedAt: stored.appliedAt,
    applyState: stored.applyState,
    applyErrorCode: stored.applyErrorCode,
    errorCount: stored.errorCount,
    managed: stored.managed,
    pendingRemovals: stored.pendingRemovals,
    bundledRemovals: stored.bundledRemovals,
    manifestEtag: stored.manifestEtag ?? base.manifestEtag,
    configDigest: stored.configDigest ?? base.configDigest,
    restart: stored.restart,
    syncedAt: stored.syncedAt ?? base.syncedAt,
  }
}

/** Read one report's `reportedAt` so the newer body wins. */
function reportTime(value: unknown): number {
  const report = record(value)
  const at = text(report?.reportedAt)
  if (at === undefined) return -1
  const parsed = Date.parse(at)
  return Number.isFinite(parsed) ? parsed : -1
}

/** Pick the report written later; undefined when neither side carries one. */
function newerReport(current: unknown, stored: unknown): unknown {
  if (current === null || current === undefined) return stored ?? null
  if (stored === null || stored === undefined) return current
  return reportTime(stored) > reportTime(current) ? stored : current
}

/**
 * Replace the state document atomically.
 * @param profile - Desktop profile directory.
 * @param state - Complete state to persist.
 */
export function saveState(profile: string, state: HubState): void {
  const path = statePath(profile)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Remove the whole connector state directory.
 * @param profile - Desktop profile directory.
 */
export function removeStateDirectory(profile: string): void {
  rmSync(join(profile, HUB_STATE_DIRECTORY), { recursive: true, force: true })
}
