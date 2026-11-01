/**
 * The Hub overlay: the one file through which the Hub configures the Host.
 *
 * The desktop Host passes `<profile>/cordis.hub.patch.yml` to the profile as its
 * last `--patch` layer, so its rows outrank the profile patch and every bundle
 * layer — the desktop equivalent of the container's `managed.patch.yml`.
 * The connector owns that file completely: it renders the delivered
 * config fragments, the reserved `hubProxy.*` block the shell reads before the
 * Host exists, and a header naming the revision, so a user who opens the file
 * sees whose it is and which manifest produced it.
 *
 * Two fragment modes exist. `enforce` always lands in the overlay; `default`
 * lands only when the user's own profile patch does not declare that row id, so
 * "the Hub suggests, the user decides" needs no separate file. Values are
 * emitted as JSON flow scalars — JSON is a YAML subset, so a whole config object
 * stays on one line and survives round-tripping through the Loader untouched.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Profile-relative overlay file name (the shell reads the same constant). */
export const HUB_OVERLAY_FILENAME = 'cordis.hub.patch.yml'

/** How many timestamped backups to keep beside the overlay. */
const KEPT_BACKUPS = 3

/** One delivered configuration fragment. */
export interface OverlayFragment {
  /** Loader row id the fragment configures. */
  readonly id: string
  /** `enforce` always lands; `default` yields to a user declaration. */
  readonly mode: 'enforce' | 'default'
  /** Whole replacement config object (the Loader does not deep-merge). */
  readonly config: Record<string, unknown>
  /** Optional operator note carried into the file header. */
  readonly note?: string
}

/** Proxy policy the shell reads from the reserved comment block. */
export interface OverlayProxy {
  /** HTTP proxy URL. */
  readonly http?: string
  /** HTTPS proxy URL. */
  readonly https?: string
  /** `NO_PROXY` value, comma separated. */
  readonly noProxy?: string
}

/** Everything one render needs. */
export interface OverlayDocument {
  /** Manifest revision the file was rendered from; null before the first manifest. */
  readonly revision: number | null
  /** Delivered fragments in delivery order. */
  readonly fragments: readonly OverlayFragment[]
  /** Proxy policy for the shell's reserved block. */
  readonly proxy?: OverlayProxy
  /** One operator sentence shown on the connector status card. */
  readonly notice?: string
  /** Keep the connector's own activation row (the overlay proved it reached the Loader). */
  readonly connectorRow: boolean
  /** Extra rows after the fragments, such as the advanced account-provider switch. */
  readonly extraRows?: readonly OverlayRow[]
  /** Whether the connector keeps the account service; false hands it to the upstream provider. */
  readonly provideAccount?: boolean
}

/** One rendered Loader patch row. */
export interface OverlayRow {
  /** Row id the patch targets. */
  readonly id?: string
  /** Rows to insert when the patch adds new entries. */
  readonly insert?: readonly Record<string, unknown>[]
  /** Replacement config for an existing row. */
  readonly config?: unknown
  /** Disable flag for an existing row. */
  readonly disabled?: boolean
}

/** Result of one render. */
export interface OverlayRender {
  /** File text, ending in exactly one newline. */
  readonly text: string
  /** Row ids a `default` fragment yielded to a user declaration for. */
  readonly skipped: readonly string[]
  /** The rows the text encodes, for tests and diagnostics. */
  readonly rows: readonly OverlayRow[]
}

/**
 * Collect the row ids a patch document declares.
 * The scan is line based on purpose: the overlay only needs to know whether the
 * user's own patch mentions an id, and a full YAML parse of a file the user
 * hand-edited would fail the boot long before an overlay decision mattered.
 * @param text - Profile `cordis.patch.yml` content; empty when the file is absent.
 * @returns Every `id:` a patch row or inserted row names.
 */
export function declaredRowIds(text: string): Set<string> {
  const ids = new Set<string>()
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:-\s*)?id:\s*["']?([A-Za-z0-9_.@/-]+)["']?\s*$/u.exec(line)
    if (match?.[1] !== undefined) ids.add(match[1])
  }
  return ids
}

/**
 * Read the profile's own patch text, tolerating its absence.
 * @param profile - Desktop profile directory.
 * @returns File content, or an empty string when the profile has no patch yet.
 */
export function readProfilePatch(profile: string): string {
  const path = join(profile, 'cordis.patch.yml')
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Serialize one JSON value as a YAML flow scalar. */
function flow(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * Render the overlay document.
 * @param document - Fragments, proxy policy, revision, and header facts.
 * @param options - Row ids the user's own profile patch declares.
 * @returns The file text plus what it skipped.
 */
export function renderOverlay(
  document: OverlayDocument,
  options: { readonly userDeclared: ReadonlySet<string> },
): OverlayRender {
  const rows: OverlayRow[] = []
  const skipped: string[] = []
  if (document.connectorRow) {
    rows.push({
      id: 'hub-connector',
      config: { configSource: 'overlay', ...document.provideAccount === false ? { provideAccount: false } : {} },
    })
  }
  for (const row of document.extraRows ?? []) rows.push(row)
  // One row id per file: a later fragment never rewrites an earlier one, so the more
  // explicit source wins (a delivered fragment, or an `extraRow` such as the account
  // switch, outranks a fragment the connector generated itself).
  const emitted = new Set<string>()
  for (const row of rows) if (row.id !== undefined) emitted.add(row.id)
  for (const fragment of document.fragments) {
    if (fragment.mode === 'default' && options.userDeclared.has(fragment.id)) {
      skipped.push(fragment.id)
      continue
    }
    if (emitted.has(fragment.id)) continue
    emitted.add(fragment.id)
    rows.push({ id: fragment.id, config: fragment.config })
  }
  const header = [
    '# DSH Hub overlay — generated by the hub connector; do not edit.',
    '#',
    '# The desktop Host passes this file to the profile as its last `--patch` layer, so',
    '# these rows outrank the profile patch and every bundle layer. Delete this file to',
    '# run the profile exactly as the user configured it.',
    `# revision: ${document.revision === null ? 'none' : String(document.revision)}`,
    `# fragments: ${String(rows.length)}${skipped.length === 0 ? '' : ` (skipped by user patch: ${skipped.join(', ')})`}`,
  ]
  if (document.notice !== undefined && document.notice !== '') header.push(`# notice: ${document.notice.replaceAll('\n', ' ')}`)
  const proxy = document.proxy
  if (proxy !== undefined && (proxy.http !== undefined || proxy.https !== undefined || proxy.noProxy !== undefined)) {
    header.push('#', '# Reserved proxy policy, read by the desktop shell before the Host starts:')
    if (proxy.http !== undefined) header.push(`# hubProxy.http=${proxy.http}`)
    if (proxy.https !== undefined) header.push(`# hubProxy.https=${proxy.https}`)
    if (proxy.noProxy !== undefined) header.push(`# hubProxy.noProxy=${proxy.noProxy}`)
  }
  const body = rows.map((row) => {
    if (row.insert !== undefined) return `- insert: ${flow(row.insert)}`
    const lines = [`- id: ${row.id ?? ''}`]
    // `disabled` is a real patch member: the account switch renders `disabled: false`
    // to put a bundle-disabled row back, so it has to survive as a boolean.
    if (row.disabled !== undefined) lines.push(`  disabled: ${String(row.disabled)}`)
    if (row.config !== undefined) lines.push(`  config: ${flow(row.config)}`)
    return lines.join('\n')
  })
  const text = `${[...header, ...body].join('\n')}\n`
  return { text, skipped, rows }
}

/**
 * Read the patch rows of an overlay document, without its generated header.
 *
 * The header names the revision, the fragment count, the operator notice and the
 * reserved proxy block; all of it is a comment the Loader never applies. What the
 * composition actually reads is the body — the rows — which is why a delivery that
 * only moves the revision on does not need a restart.
 * @param text - Overlay file text.
 * @returns The rows, or an empty string for a document without any.
 */
export function overlayBody(text: string): string {
  const lines = text.split(/\r?\n/u)
  const first = lines.findIndex(line => line !== '' && !line.startsWith('#'))
  return first === -1 ? '' : lines.slice(first).join('\n').trimEnd()
}

/**
 * Render an empty overlay: a valid patch document that changes nothing.
 * @param connectorRow - Whether to keep the connector's own activation row.
 * @returns File text for a profile with no delivered configuration.
 */
export function emptyOverlay(connectorRow: boolean): string {
  return renderOverlay({ revision: null, fragments: [], connectorRow }, { userDeclared: new Set() }).text
}

/**
 * Write the overlay atomically, keeping the most recent previous versions.
 * @param profile - Desktop profile directory.
 * @param text - Complete file text.
 * @returns Absolute path written.
 */
export function writeOverlay(profile: string, text: string): string {
  const path = join(profile, HUB_OVERLAY_FILENAME)
  if (readOverlay(profile) === text) return path
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path)) {
    const stamped = `${path}.bak-${String(Date.now())}`
    renameSync(path, stamped)
    trimBackups(profile)
  }
  const temporary = `${path}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
  return path
}

/**
 * Delete every backup beyond the newest few.
 * @param profile - Desktop profile directory.
 */
function trimBackups(profile: string): void {
  const prefix = `${HUB_OVERLAY_FILENAME}.bak-`
  const backups = readdirSync(profile)
    .filter(name => name.startsWith(prefix))
    .sort((left, right) => Number(right.slice(prefix.length)) - Number(left.slice(prefix.length)))
  for (const name of backups.slice(KEPT_BACKUPS)) rmSync(join(profile, name), { force: true })
}

/**
 * Read the overlay text, tolerating its absence.
 * @param profile - Desktop profile directory.
 * @returns File content, or undefined when there is no overlay.
 */
export function readOverlay(profile: string): string | undefined {
  const path = join(profile, HUB_OVERLAY_FILENAME)
  if (!existsSync(path)) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
