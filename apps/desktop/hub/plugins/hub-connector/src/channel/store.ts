/**
 * Durable switch and binding of the phone channel.
 *
 * The record lives beside the connector state as `<profile>/desktop-hub/channel.json`
 * and holds no credential: the Hub device token stays in the credential store,
 * read on demand. A missing, unreadable, or older-versioned file reads as
 * "switch off, no binding", which is the only safe default.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseBinding } from './binding.ts'
import { HUB_STATE_DIRECTORY } from '../state.ts'
import type { ChannelBinding, ChannelSwitch } from './types.ts'

/** Version of the channel record; a mismatch reads as off. */
const CHANNEL_VERSION = 1

/** File name inside the connector's state directory. */
const CHANNEL_FILE = 'channel.json'

/** What the file holds. */
export interface ChannelRecord {
  /** Local switch, off unless the user turned it on. */
  readonly enabled: boolean
  /** When the switch was last turned on, ISO-8601. */
  readonly enabledAt: string | null
  /** Account and node the switch applies to, or null after a sign-out. */
  readonly binding: ChannelBinding | null
}

/** The record a profile reads before the user ever touched the switch. */
export function defaultChannelRecord(): ChannelRecord {
  return { enabled: false, enabledAt: null, binding: null }
}

/**
 * Absolute path of the channel record.
 * @param profile - desktop profile directory.
 * @returns path of `desktop-hub/channel.json`.
 */
export function channelRecordPath(profile: string): string {
  return join(profile, HUB_STATE_DIRECTORY, CHANNEL_FILE)
}

/**
 * Read the persisted record.
 * @param profile - desktop profile directory.
 * @returns the stored record, or the default one when the file is absent or unusable.
 */
export function readChannelRecord(profile: string): ChannelRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(channelRecordPath(profile), 'utf8')) as unknown
  } catch {
    // Absent and unreadable both mean the user has no switch yet.
    return defaultChannelRecord()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return defaultChannelRecord()
  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== CHANNEL_VERSION) return defaultChannelRecord()
  const enabled = record.enabled === true
  const enabledAt = typeof record.enabledAt === 'string' && !Number.isNaN(Date.parse(record.enabledAt))
    ? record.enabledAt
    : null
  const binding = parseBinding(record.binding)
  // The binding outlives the switch: the account page names the bound account
  // while the switch is off. An enabled switch without a binding cannot be
  // honoured, so it reads as off.
  if (!enabled) return { enabled: false, enabledAt: null, binding: binding ?? null }
  if (binding === undefined) return { enabled: false, enabledAt: null, binding: null }
  return { enabled, enabledAt, binding }
}

/**
 * Replace the persisted record atomically.
 * @param profile - desktop profile directory.
 * @param record - complete record to persist.
 */
export function writeChannelRecord(profile: string, record: ChannelRecord): void {
  const path = channelRecordPath(profile)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp`
  const document = {
    schemaVersion: CHANNEL_VERSION,
    enabled: record.enabled,
    enabledAt: record.enabledAt,
    binding: record.binding,
  }
  writeFileSync(temporary, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Project the record's switch for the status surface.
 * @param record - persisted record.
 * @returns `on` only for an enabled record with a binding.
 */
export function switchOf(record: ChannelRecord): ChannelSwitch {
  return record.enabled && record.binding !== null ? 'on' : 'off'
}
