/**
 * Startup migration of the Hub overlay's model rows.
 *
 * Earlier desktop builds let the Hub connector write `llm-pi-ai` and
 * `agent-default-model` into `cordis.hub.patch.yml`, the profile's last `--patch`
 * layer. A row there outranks the profile patch, so the Models page could not
 * save a personal provider: `ConfigEditor.edit()` compares the composed value
 * with the requested one and refuses whenever an overlay row wins.
 *
 * The Host is the only place that runs before those layers are read, so the
 * migration happens here: the two model rows leave the file, their content is
 * parked in `desktop-hub/legacy-models.json` for the connector to import as a
 * managed provider set, and every other row, the header, and the reserved proxy
 * block stay byte-for-byte. Running it again changes nothing, and a file this
 * module cannot read is reported and left alone.
 *
 * The replacement never removes the original first: the new document is written
 * beside it, a copy of the old one becomes the backup, and one atomic rename puts
 * the new document in place. A failure at any step leaves the original exactly as
 * it was, so the account, search, proxy, and plugin rows it may carry keep loading.
 *
 * @module @deepseek-ai/dsh-desktop-host/hub-overlay
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Hub-managed overlay file in the desktop profile directory. */
export const HUB_OVERLAY_FILENAME = 'cordis.hub.patch.yml'

/** Rows the model adapter registers instead of the overlay. */
const MODEL_ROWS: readonly string[] = ['llm-pi-ai', 'agent-default-model']

/** Connector-owned directory below the profile. */
const HUB_STATE_DIRECTORY = 'desktop-hub'

/** Migration file the connector imports once and removes. */
export const LEGACY_MODEL_FILE = 'legacy-models.json'

/** How many timestamped backups of the overlay to keep, matching the connector. */
const KEPT_BACKUPS = 3

/** What one migration pass did. */
export interface HubOverlayMigrationResult {
  /** Whether the file lost rows. */
  readonly migrated: boolean
  /** Row ids moved out of the overlay. */
  readonly removed: readonly string[]
  /** Backup of the file as it was, when one was written. */
  readonly backup?: string
  /** Why the file was not migrated; the original stays in place. */
  readonly error?: string
}

/** One body row of the overlay, kept as its original lines. */
interface OverlayRowText {
  readonly id: string | undefined
  readonly lines: readonly string[]
}

/** What one row's `config:` member yielded. */
type RowConfig =
  | { readonly kind: 'none' }
  | { readonly kind: 'parsed'; readonly value: Record<string, unknown> }
  | { readonly kind: 'unreadable' }

/** Narrow an unknown value to a plain record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read the row id one sequence item declares, if any. */
function rowId(lines: readonly string[]): string | undefined {
  const first = lines[0] ?? ''
  const match = /^-\s+id:\s*["']?([^"'\s#]+)["']?\s*$/u.exec(first)
  return match?.[1]
}

/** Read one row's `config:` member, distinguishing absent from unparsable. */
function rowConfig(lines: readonly string[]): RowConfig {
  for (const [index, line] of lines.entries()) {
    const match = /^(\s+)config:\s*(.*)$/u.exec(line)
    if (match?.[2] === undefined) continue
    const inline = match[2]
    if (inline === '') {
      // A block-style config continues on the following indented lines; this
      // migration only knows the connector's own one-line JSON rendering.
      const next = lines[index + 1]
      return next !== undefined && /^\s{4,}\S/u.test(next) ? { kind: 'unreadable' } : { kind: 'none' }
    }
    try {
      const value = record(JSON.parse(inline))
      return value === undefined ? { kind: 'unreadable' } : { kind: 'parsed', value }
    } catch {
      return { kind: 'unreadable' }
    }
  }
  return { kind: 'none' }
}

/** Split the document into its header lines and one entry per `- ` sequence item. */
function splitRows(text: string): { header: readonly string[]; rows: readonly OverlayRowText[] } | undefined {
  const lines = text.split(/\r?\n/u)
  const bodyStart = lines.findIndex(line => line !== '' && !line.startsWith('#'))
  if (bodyStart === -1) return { header: lines, rows: [] }
  const header = lines.slice(0, bodyStart)
  const rows: OverlayRowText[] = []
  let current: string[] = []
  for (const line of lines.slice(bodyStart)) {
    if (line.startsWith('- ')) {
      if (current.length > 0) rows.push({ id: rowId(current), lines: current })
      current = [line]
      continue
    }
    if (current.length === 0) {
      // Content that is neither a comment nor a sequence item: this is not the
      // document the connector renders, so the caller leaves it untouched.
      return undefined
    }
    current.push(line)
  }
  if (current.length > 0) rows.push({ id: rowId(current), lines: current })
  return { header, rows }
}

/** Write one file atomically, creating its directory. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${String(process.pid)}`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
}

/** File operations the migration needs; replaced in tests to inject one failure. */
export interface HubOverlayMigrationIo {
  /**
   * Put the prepared document in place of the original.
   * @param temporary - Complete new document beside the original.
   * @param path - The overlay path to replace.
   */
  readonly replace: (temporary: string, path: string) => void
}

/** Default replacement: one rename, which replaces the target atomically. */
const DEFAULT_IO: HubOverlayMigrationIo = {
  replace: (temporary, path) => { renameSync(temporary, path) },
}

/** Remove one migration artifact, keeping the caller's failure as the reported cause. */
function removeQuietly(path: string): void {
  try { rmSync(path, { recursive: true, force: true }) } catch { /* the failure path reports the original cause */ }
}

/** A backup path that is not already taken. */
function backupPath(path: string): string {
  const base = `${path}.bak-${String(Date.now())}`
  let candidate = base
  for (let attempt = 1; existsSync(candidate); attempt += 1) candidate = `${base}-${String(attempt)}`
  return candidate
}

/** Keep only the newest few backups of the overlay. */
function trimBackups(profile: string): void {
  const prefix = `${HUB_OVERLAY_FILENAME}.bak-`
  const backups = readdirSync(profile)
    .filter(name => name.startsWith(prefix))
    .sort((left, right) => Number(right.slice(prefix.length)) - Number(left.slice(prefix.length)))
  for (const name of backups.slice(KEPT_BACKUPS)) rmSync(join(profile, name), { force: true })
}

/**
 * Move the Hub overlay's model rows into connector-owned migration state.
 *
 * The result is idempotent: a file without those rows is untouched, and the
 * extraction file is written only when it does not exist yet.
 * @param profile - Desktop profile directory.
 * @param io - Replacement step, injectable for one fault-injection test.
 * @returns What the pass removed, the backup path, or the refusal reason.
 */
export function migrateHubOverlayModels(
  profile: string,
  io: HubOverlayMigrationIo = DEFAULT_IO,
): HubOverlayMigrationResult {
  const path = join(profile, HUB_OVERLAY_FILENAME)
  if (!existsSync(path)) return { migrated: false, removed: [] }
  const text = readFileSync(path, 'utf8')
  const parsed = splitRows(text)
  if (parsed === undefined) {
    return MODEL_ROWS.some(id => text.includes(`id: ${id}`))
      ? { migrated: false, removed: [], error: `${path} carries model rows this migration cannot parse; the file is left in place` }
      : { migrated: false, removed: [] }
  }
  const removed: string[] = []
  const kept: OverlayRowText[] = []
  let providers: Record<string, unknown> | undefined
  let selection: Record<string, unknown> | undefined
  for (const row of parsed.rows) {
    if (row.id === undefined || !MODEL_ROWS.includes(row.id)) {
      kept.push(row)
      continue
    }
    const config = rowConfig(row.lines)
    if (config.kind === 'unreadable') {
      return { migrated: false, removed: [], error: `${path}: the ${row.id} row has a config this migration cannot parse; the file is left in place` }
    }
    if (config.kind === 'parsed') {
      if (row.id === 'llm-pi-ai') providers = record(config.value.providers)
      else {
        const provider = config.value.provider
        const model = config.value.model
        if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
          const effort = config.value.reasoningEffort
          selection = { provider, model, ...typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {} }
        }
      }
    }
    removed.push(row.id)
  }
  if (removed.length === 0) return { migrated: false, removed: [] }
  const legacyPath = join(profile, HUB_STATE_DIRECTORY, LEGACY_MODEL_FILE)
  const temporary = `${path}.migrating`
  const next = [...parsed.header, ...kept.flatMap(row => row.lines)].join('\n')
  const nextText = next.endsWith('\n') ? next : `${next}\n`
  let stamped: string | undefined
  let succeeded = false
  try {
    // 1. Prepare the complete replacement beside the original.
    writeFileSync(temporary, nextText, { mode: 0o600 })
    // 2. Park the extracted model set; an unreadable or unwritable file aborts the
    //    whole pass, so the original overlay never loses rows without a consumer.
    if (!existsSync(legacyPath)) {
      const legacy = { providers: providers ?? {}, ...selection === undefined ? {} : { defaultSelection: selection } }
      writeAtomic(legacyPath, `${JSON.stringify(legacy, undefined, 2)}\n`)
    }
    // 3. Copy — not move — the original to its backup, so the overlay path keeps a
    //    valid document until the atomic replacement below.
    stamped = backupPath(path)
    copyFileSync(path, stamped)
    // 4. One atomic swap. On failure the original is still in place.
    io.replace(temporary, path)
    succeeded = true
    return { migrated: true, removed, backup: stamped }
  } catch (error) {
    removeQuietly(temporary)
    // A backup this pass created carries the same bytes as the untouched original;
    // removing it keeps "backup present" meaning "an earlier document exists".
    if (stamped !== undefined) removeQuietly(stamped)
    return {
      migrated: false,
      removed: [],
      error: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    // Housekeeping is not part of the migration: an unreadable old backup must not
    // turn a completed migration into a failure, and this pass's backup must never
    // be removed by the cleanup itself.
    if (succeeded) {
      try { trimBackups(profile) } catch { /* keep every backup when trimming fails */ }
    }
  }
}
