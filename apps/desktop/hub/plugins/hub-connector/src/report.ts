/**
 * The device report: the one write the Hub accepts from a desktop.
 *
 * The Hub validates this body with `z.strictObject`, so an unexpected member is
 * a 400 rather than a dropped field. That makes the allowlist below the client
 * half of a privacy boundary, and this builder is its only producer:
 * every key it emits is on the list, every listed key it can emit is here, and a
 * plugin entry is built the same way. Callers pass already-sanitized facts —
 * nothing in this module reads a file, a path, or an environment value.
 */

import type { HubState, ManagedPluginRecord } from './state.ts'

/**
 * Members `POST /api/desktop/devices/report` accepts (Hub `DESKTOP_REPORT_KEYS`).
 * Adding one means changing the Hub schema, its migration, and this key allowlist together.
 */
export const DESKTOP_REPORT_KEYS: readonly string[] = [
  'schemaVersion',
  'reportedAt',
  'appVersion',
  'appChannel',
  'runtimeVersion',
  'appliedRevision',
  'appliedAt',
  'applyState',
  'applyErrorCode',
  'errorCount',
  'plugins',
]

/** Members one `plugins[]` entry accepts (Hub `DesktopPluginEntrySchema`). */
export const DESKTOP_PLUGIN_KEYS: readonly string[] = ['name', 'version', 'source', 'state', 'errorCode']

/** Required report members; the Hub rejects the body without them. */
const REQUIRED_REPORT_KEYS: readonly string[] = [
  'schemaVersion',
  'reportedAt',
  'appliedRevision',
  'appliedAt',
  'applyState',
  'applyErrorCode',
]

/** Plugin states the Hub stores. */
export type PluginState = 'enabled' | 'disabled' | 'failed' | 'absent'

/** One entry of `plugins[]`. */
export interface PluginReportEntry {
  readonly name: string
  readonly version: string
  readonly source: ManagedPluginRecord['source']
  readonly state: PluginState
  readonly errorCode?: string
}

/** Everything the builder may say about this device. */
export interface DeviceReportInput {
  /** Clock reading for `reportedAt`; the Hub only uses it for skew. */
  readonly reportedAt: string
  /** Application version; sent when it changed since the previous report. */
  readonly appVersion?: string
  /** Release channel; sent alongside the version. */
  readonly appChannel?: string
  /** Bundled runtime version. */
  readonly runtimeVersion?: string | null
  /** Revision last applied, or null before the first manifest. */
  readonly appliedRevision: number | null
  /** When that revision applied. */
  readonly appliedAt: string | null
  /** Outcome of the last application. */
  readonly applyState: 'unknown' | 'applied' | 'partial' | 'pending' | 'failed'
  /** First failure cause from the Hub's fixed enum, or null. */
  readonly applyErrorCode: string | null
  /** How many entries failed. */
  readonly errorCount: number
  /** Managed plugins, already mapped from manifest levels. */
  readonly plugins: readonly PluginReportEntry[]
}

/** A report body, typed as the exact JSON the builder produced. */
export type DeviceReportBody = Record<string, unknown>

/**
 * Fail when a body carries a member the Hub does not accept, or lacks a required one.
 * @param body - Candidate report or plugin entry.
 * @param allowlist - Members the Hub accepts at that level.
 * @param required - Members that must be present.
 * @throws {Error} Naming the offending member, so a privacy regression fails the first test run.
 */
export function assertMembers(body: Record<string, unknown>, allowlist: readonly string[], required: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowlist.includes(key)) throw new Error(`device report: "${key}" is not on the Hub allowlist`)
  }
  for (const key of required) {
    if (!Object.hasOwn(body, key)) throw new Error(`device report: "${key}" is required by the Hub contract`)
  }
}

/** Drop `undefined` members so the emitted JSON never carries a null hole. */
function compact(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined))
}

/**
 * Map a manifest `level` onto the report's `source`.
 * @param level - Manifest level.
 * @returns The Hub enum value for that level.
 */
export function sourceOfLevel(level: 'core' | 'default' | 'optional'): ManagedPluginRecord['source'] {
  if (level === 'core') return 'hub-core'
  if (level === 'default') return 'hub-default'
  return 'hub-optional'
}

/**
 * Build one report body and prove it against the Hub allowlist.
 * @param input - Sanitized device facts.
 * @returns The JSON body to POST, already key-checked.
 * @throws {Error} When a member falls outside the Hub contract.
 */
export function buildDeviceReport(input: DeviceReportInput): DeviceReportBody {
  const plugins = input.plugins.map((entry) => {
    const body = compact({
      name: entry.name,
      version: entry.version,
      source: entry.source,
      state: entry.state,
      errorCode: entry.state === 'failed' ? entry.errorCode ?? 'unknown' : undefined,
    })
    assertMembers(body, DESKTOP_PLUGIN_KEYS, ['name', 'version', 'source', 'state'])
    return body
  })
  const body = compact({
    schemaVersion: 1,
    reportedAt: input.reportedAt,
    appVersion: input.appVersion,
    appChannel: input.appChannel,
    runtimeVersion: input.runtimeVersion ?? undefined,
    appliedRevision: input.appliedRevision,
    appliedAt: input.appliedAt,
    applyState: input.applyState,
    applyErrorCode: input.applyErrorCode,
    errorCount: input.errorCount,
    plugins,
  })
  assertMembers(body, DESKTOP_REPORT_KEYS, REQUIRED_REPORT_KEYS)
  return body
}

/**
 * Project the durable state onto a report body.
 * @param state - Connector state; its `applyState` and `managed` list drive the report.
 * @param options - Values the state does not carry (clock, build identity).
 * @returns The report body for the next heartbeat.
 */
export function reportFromState(state: HubState, options: {
  readonly reportedAt: string
  readonly appVersion: string
  readonly appChannel: string
  readonly runtimeVersion: string | null
  readonly plugins: readonly PluginReportEntry[]
}): DeviceReportBody {
  return buildDeviceReport({
    reportedAt: options.reportedAt,
    appVersion: options.appVersion,
    appChannel: options.appChannel,
    runtimeVersion: options.runtimeVersion,
    appliedRevision: state.appliedRevision,
    appliedAt: state.appliedAt,
    applyState: state.applyState,
    applyErrorCode: state.applyErrorCode,
    errorCount: state.errorCount,
    plugins: options.plugins,
  })
}
