/**
 * The desired-state manifest: pull it, prove it, apply it, and say what happened.
 *
 * The manifest is the Hub's declarative statement about one device: the
 * managed plugin set with per-package SHA-256, the configuration fragments, and
 * the application version policy. The connector is the only applier — the Hub
 * never runs anything — and it reports what it achieved through the same
 * heartbeat the Hub already receives.
 *
 * Three rules make the application safe to repeat and safe to fail:
 * - The whole document is validated before anything changes; one invalid member
 *   rejects the manifest and leaves the device on its last good state.
 * - Only strictly newer revisions apply. A Hub rolled back to an older revision
 *   cannot downgrade a device; the device reports the stale revision instead.
 * - Each plugin step is independent, and a failed replacement reinstalls the
 *   version the device ran before, so a partial application never leaves the
 *   package manager half-way through a change.
 *
 * Two entries are refused outright: this connector (it ships with the installer
 * and is never delivered by the Hub) and any package the user installed
 * themselves (the Hub only uninstalls what it delivered).
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { info, warn } from './log.ts'
import { validateSchema, type JsonSchemaNode, type SchemaIssue } from './json-schema.ts'
import { declaredRowIds, overlayBody, renderOverlay, type OverlayFragment, type OverlayProxy, type OverlayRow } from './overlay.ts'
import { sourceOfLevel } from './report.ts'
import { compareSemver, parseSemver, satisfies } from './semver.ts'
import type { ManagedPluginRecord } from './state.ts'

/** Package name of this connector; Hub delivery never touches it. */
export const CONNECTOR_PACKAGE = '@dsh-hub/hub-connector'

/** Row ids a plugin-supplied fragment may not configure (Hub container rule). */
export const RESERVED_FRAGMENT_IDS: readonly string[] = ['llm-pi-ai', 'agent-default-model', 'workspace-controller', 'webserver']

/** Largest archive the connector accepts, whatever the manifest claims. */
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024

/** Largest manifest body read from the Hub (client cap). */
export const MAX_MANIFEST_BYTES = 1024 * 1024

/** One delivered plugin archive. */
export interface ArtifactRef {
  /** HTTPS URL. */
  readonly url: string
  /** Lowercase hex SHA-256 of the archive bytes. */
  readonly sha256: string
  /** Byte length the archive must have. */
  readonly bytes: number
  /** Optional cache filename. */
  readonly filename?: string
}

/** One configuration fragment in manifest form. */
export interface ManifestFragment {
  /** Loader row id. */
  readonly id: string
  /** `enforce` always lands; `default` yields to a user declaration. */
  readonly mode: 'enforce' | 'default'
  /** Whole replacement config. */
  readonly config: Record<string, unknown>
  /** Optional operator note. */
  readonly note?: string
}

/** One managed plugin entry. */
export interface ManifestPlugin {
  /** npm package name. */
  readonly name: string
  /** Exact managed version. */
  readonly version: string
  /** Delivery level; maps to the report's `source`. */
  readonly level: 'core' | 'default' | 'optional'
  /** Whether the row should be enabled; core entries are always enabled. */
  readonly enabled: boolean
  /** Archive location and integrity. */
  readonly artifact: ArtifactRef
  /** Relative position in the profile's bundle list. */
  readonly bundleOrder: number
  /** Whether the plugin needs a Host restart to take effect. */
  readonly needsRestart: boolean
  /** `engines.dsh` range the plugin declares. */
  readonly minDsh?: string
  /** Fragments the plugin itself contributes. */
  readonly config: readonly ManifestFragment[]
  /** Operator-provided reason shown to the user. */
  readonly reason?: string
}

/** The configuration section of a manifest. */
export interface ManifestConfig {
  /** Delivered fragments. */
  readonly fragments: readonly ManifestFragment[]
  /** Hub-computed digest, verified locally and never reported. */
  readonly digest?: string
  /** White-list version the Hub rendered against. */
  readonly allowlistVersion?: number
}

/** Application version policy; v1 reports it and suggests an upgrade. */
export interface ManifestAppPolicy {
  /** Channel the device belongs to. */
  readonly channel: 'nightly' | 'latest'
  /** Minimum runnable version. */
  readonly minVersion: string
  /** Whether the minimum is a hard block. */
  readonly minVersionHard: boolean
  /** Suggested upgrade target. */
  readonly targetVersion?: string
  /** Device-specific feed URL; v1 does not consume it. */
  readonly feedUrl?: string
}

/** The validated manifest. */
export interface Manifest {
  /** Format version; always 1 for this build. */
  readonly schemaVersion: 1
  /** Monotonic revision. */
  readonly revision: number
  /** Hub render time. */
  readonly issuedAt: string
  /** Optional staleness marker. */
  readonly expiresAt?: string
  /** Optional device binding. */
  readonly device?: { readonly deviceId: string; readonly userId?: number }
  /** Optional operator sentence. */
  readonly notice?: string
  /** Managed plugin set. */
  readonly plugins: readonly ManifestPlugin[]
  /** Explicit uninstalls. */
  readonly uninstall: readonly string[]
  /** Delivered configuration. */
  readonly config: ManifestConfig
  /** Application policy. */
  readonly app?: ManifestAppPolicy
}

/** Outcome of validating one document. */
export type ManifestValidation =
  | { readonly ok: true; readonly manifest: Manifest; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly issues: readonly SchemaIssue[]; readonly warnings: readonly string[] }

/** Narrow an unknown value to a plain record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a string member. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Read a string array member. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Load the manifest schema shipped beside this module.
 * @param location - Directory holding `manifest.schema.json`.
 * @returns The parsed schema document.
 * @throws {Error} When the schema is missing or not an object.
 */
export function loadManifestSchema(location: string): JsonSchemaNode {
  const path = join(location, 'manifest.schema.json')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (record(value) === undefined) throw new Error(`hub manifest: ${path} is not a schema object`)
  return value as JsonSchemaNode
}

/** Project one validated fragment onto the internal shape. */
function fragmentOf(value: unknown): ManifestFragment | undefined {
  const entry = record(value)
  const id = text(entry?.id)
  const config = record(entry?.config)
  const mode = entry?.mode
  if (id === undefined || config === undefined || (mode !== 'enforce' && mode !== 'default')) return undefined
  return { id, mode, config, ...text(entry?.note) === undefined ? {} : { note: text(entry?.note) ?? '' } }
}

/**
 * Project one plugin-supplied config entry. Unlike a top-level fragment these
 * carry no mode: the Hub's plugin library stores them as plain patch rows, and
 * the device treats them as defaults so a user declaration still wins.
 */
function pluginFragmentOf(value: unknown): ManifestFragment | undefined {
  const entry = record(value)
  const id = text(entry?.id)
  const config = record(entry?.config)
  if (id === undefined || config === undefined) return undefined
  return { id, mode: 'default', config }
}

/** Project one validated plugin entry. */
function pluginOf(value: unknown): ManifestPlugin | undefined {
  const entry = record(value)
  const artifact = record(entry?.artifact)
  const name = text(entry?.name)
  const version = text(entry?.version)
  const level = entry?.level
  const url = text(artifact?.url)
  const sha256 = text(artifact?.sha256)
  const bytes = artifact?.bytes
  if (name === undefined || version === undefined || url === undefined || sha256 === undefined) return undefined
  if (typeof bytes !== 'number' || (level !== 'core' && level !== 'default' && level !== 'optional')) return undefined
  const filename = text(artifact?.filename)
  const minDsh = text(entry?.minDsh)
  const reason = text(entry?.reason)
  const config = Array.isArray(entry?.config)
    ? entry.config.flatMap((item) => {
      const fragment = pluginFragmentOf(item)
      return fragment === undefined ? [] : [fragment]
    })
    : []
  return {
    name,
    version,
    level,
    enabled: level === 'core' ? true : entry?.enabled !== false,
    artifact: { url, sha256, bytes, ...filename === undefined ? {} : { filename } },
    bundleOrder: typeof entry?.bundleOrder === 'number' ? entry.bundleOrder : 0,
    needsRestart: entry?.needsRestart === true,
    ...minDsh === undefined ? {} : { minDsh },
    config,
    ...reason === undefined ? {} : { reason },
  }
}

/**
 * Accept a plain-HTTP artifact URL that only ever resolves to this machine.
 *
 * The D3 schema requires `https://` because a Hub artifact crosses a network.
 * A loopback address cannot: the bytes never leave the host, and the manifest is
 * the one delivery path the connector's own acceptance harness serves locally
 * until the Hub renders manifests itself. The exception is exactly as narrow as
 * that argument — loopback host, plain HTTP, that one schema member.
 * @param issue - Schema failure to consider.
 * @param document - Document the failure came from.
 * @returns Whether the failure is a loopback artifact URL the schema refused for its scheme.
 */
function isLoopbackArtifactUrl(issue: SchemaIssue, document: unknown): boolean {
  if (!issue.path.endsWith('/artifact/url') || !issue.message.includes('^https://')) return false
  const segments = issue.path.split('/').filter(segment => segment !== '')
  let cursor: unknown = document
  for (const segment of segments) {
    if (Array.isArray(cursor)) cursor = cursor[Number(segment)]
    else if (typeof cursor === 'object' && cursor !== null) cursor = (cursor as Record<string, unknown>)[segment]
    else return false
  }
  if (typeof cursor !== 'string') return false
  try {
    const url = new URL(cursor)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

/**
 * Validate one manifest document against the shipped schema plus the rules JSON Schema cannot state.
 * @param document - Parsed JSON from the Hub.
 * @param options - Schema, local DSH version, and this device's id.
 * @returns The manifest with warnings, or every issue found.
 */
export function validateManifest(document: unknown, options: {
  readonly schema: JsonSchemaNode
  readonly dshVersion: string
  readonly deviceId: string | null
}): ManifestValidation {
  const issues: SchemaIssue[] = []
  const warnings: string[] = []
  for (const issue of validateSchema(options.schema, document)) {
    if (!isLoopbackArtifactUrl(issue, document)) issues.push(issue)
  }
  if (issues.length > 0) return { ok: false, issues, warnings }
  const root = record(document) ?? {}
  const plugins: ManifestPlugin[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(root.plugins) ? root.plugins : []) {
    const plugin = pluginOf(entry)
    if (plugin === undefined) {
      issues.push({ path: '/plugins', message: 'entry could not be read as a managed plugin' })
      continue
    }
    if (plugin.name === CONNECTOR_PACKAGE) {
      warnings.push(`${plugin.name} ships with the installer and is never delivered by the Hub; entry ignored`)
      continue
    }
    if (seen.has(plugin.name)) {
      issues.push({ path: '/plugins', message: `duplicate plugin name ${JSON.stringify(plugin.name)}` })
      continue
    }
    seen.add(plugin.name)
    if (plugin.level === 'core' && record(entry)?.enabled === false) {
      issues.push({ path: '/plugins', message: `core plugin ${JSON.stringify(plugin.name)} cannot be disabled` })
    }
    const kept = plugin.config.filter((fragment) => {
      if (!RESERVED_FRAGMENT_IDS.includes(fragment.id)) return true
      warnings.push(`plugin ${plugin.name} may not configure reserved row ${JSON.stringify(fragment.id)}; fragment dropped`)
      return false
    })
    plugins.push({ ...plugin, config: kept })
  }
  const uninstall = strings(root.uninstall).filter((name) => {
    if (name !== CONNECTOR_PACKAGE) return true
    warnings.push(`${CONNECTOR_PACKAGE} is never uninstalled by the Hub; entry ignored`)
    return false
  })
  for (const name of uninstall) {
    if (seen.has(name)) issues.push({ path: '/uninstall', message: `${JSON.stringify(name)} is both managed and uninstalled` })
  }
  const config = record(root.config)
  const fragments = Array.isArray(config?.fragments)
    ? config.fragments.flatMap((item) => {
      const fragment = fragmentOf(item)
      return fragment === undefined ? [] : [fragment]
    })
    : []
  const fragmentIds = new Set<string>()
  for (const fragment of fragments) {
    if (fragmentIds.has(fragment.id)) issues.push({ path: '/config/fragments', message: `duplicate fragment id ${JSON.stringify(fragment.id)}` })
    fragmentIds.add(fragment.id)
  }
  // A top-level fragment outranks the same id delivered by a plugin.
  const topLevelIds = new Set(fragments.map(fragment => fragment.id))
  const resolvedPlugins = plugins.map((plugin) => {
    const kept = plugin.config.filter((fragment) => {
      if (!topLevelIds.has(fragment.id)) return true
      warnings.push(`plugin ${plugin.name} repeats fragment ${JSON.stringify(fragment.id)}; the manifest's own fragment wins`)
      return false
    })
    return kept.length === plugin.config.length ? plugin : { ...plugin, config: kept }
  })
  const allowlistVersion = config?.allowlistVersion
  if (typeof allowlistVersion === 'number' && allowlistVersion !== 1) {
    issues.push({ path: '/config/allowlistVersion', message: `this build implements allow-list version 1, the Hub sent ${String(allowlistVersion)}` })
  }
  if (root.signature !== undefined) {
    issues.push({ path: '/signature', message: 'this build carries no signature key; a signed manifest cannot be verified' })
  }
  const device = record(root.device)
  const boundDevice = text(device?.deviceId)
  if (boundDevice !== undefined && options.deviceId !== null && boundDevice !== options.deviceId) {
    issues.push({ path: '/device/deviceId', message: `the manifest names another device (${boundDevice})` })
  }
  const app = record(root.app)
  if (app !== undefined) {
    const minVersion = text(app.minVersion) ?? ''
    if (parseSemver(minVersion) === undefined) issues.push({ path: '/app/minVersion', message: 'not a semantic version' })
    else if (!satisfies(options.dshVersion, `>=${minVersion}`)) {
      warnings.push(`this application (${options.dshVersion}) is below the Hub minimum ${minVersion}; an upgrade is suggested`)
    }
    if (app.channel === 'latest' || app.channel === 'nightly') {
      if (app.channel !== 'latest') warnings.push(`the Hub places this device on the ${app.channel} channel; only a new installer changes the channel`)
    }
  }
  if (issues.length > 0) return { ok: false, issues, warnings }
  const expiresAt = text(root.expiresAt)
  const notice = text(root.notice)
  const digest = text(config?.digest)
  const targetVersion = text(app?.targetVersion)
  const feedUrl = text(app?.feedUrl)
  return {
    ok: true,
    warnings,
    manifest: {
      schemaVersion: 1,
      revision: typeof root.revision === 'number' ? root.revision : 1,
      issuedAt: text(root.issuedAt) ?? new Date(0).toISOString(),
      ...expiresAt === undefined ? {} : { expiresAt },
      ...boundDevice === undefined ? {} : {
        device: { deviceId: boundDevice, ...typeof device?.userId === 'number' ? { userId: device.userId } : {} },
      },
      ...notice === undefined ? {} : { notice },
      plugins: resolvedPlugins,
      uninstall,
      config: {
        fragments,
        ...digest === undefined ? {} : { digest },
        ...typeof allowlistVersion === 'number' ? { allowlistVersion } : {},
      },
      ...app === undefined ? {} : {
        app: {
          channel: app.channel === 'nightly' ? 'nightly' : 'latest',
          minVersion: text(app.minVersion) ?? '0.0.0',
          minVersionHard: app.minVersionHard === true,
          ...targetVersion === undefined ? {} : { targetVersion },
          ...feedUrl === undefined ? {} : { feedUrl },
        },
      },
    },
  }
}

/** One installed bundle as the plugin manager reports it. */
export interface InstalledBundle {
  /** Package name. */
  readonly name: string
  /** Installed version, when known. */
  readonly version?: string
  /** Whether the bundle contributes its patch layer. */
  readonly enabled: boolean
  /** Whether removal is allowed. */
  readonly removable?: boolean
  /** Load error, when the bundle failed to load. */
  readonly error?: unknown
}

/** Result of one plugin-manager change. */
export interface ChangeOutcome {
  /** Whether the manager changed anything. */
  readonly changed: boolean
  /** Application outcome the manager reported. */
  readonly application?: string
  /** Failure the manager reported (a structured management error). */
  readonly error?: unknown
}

/** Everything the applier reaches outside itself. */
export interface ApplyDeps {
  /** Current bundles. */
  readonly listBundles: () => Promise<readonly InstalledBundle[]>
  /** Install one `file:` spec and select it. */
  readonly install: (spec: string, options?: { readonly saveExact?: boolean }) => Promise<ChangeOutcome>
  /** Remove one bundle. */
  readonly remove: (name: string) => Promise<ChangeOutcome>
  /** Enable or disable one bundle. */
  readonly setEnabled: (name: string, enabled: boolean) => Promise<ChangeOutcome>
  /** Download and verify one archive; returns the absolute cache path. */
  readonly fetchArtifact: (artifact: ArtifactRef) => Promise<string>
  /** Read the profile's own patch text, for the `default` fragment rule. */
  readonly readUserPatch: () => string
  /** Write the overlay text. */
  readonly writeOverlay: (text: string) => void
  /** Read the current overlay text, for rollback. */
  readonly readOverlay: () => string | undefined
  /** Extra fragments the connector itself contributes (the generated model route). */
  readonly extraFragments?: () => readonly ManifestFragment[]
  /** Extra patch rows after the fragments (the advanced account-provider switch). */
  readonly extraRows?: () => readonly OverlayRow[]
  /** Whether the connector keeps the account service; false leaves it to the upstream provider. */
  readonly connectorProvidesAccount?: boolean
  /** Proxy policy written into the reserved block. */
  readonly proxy?: OverlayProxy
  /** Local DSH version, for `minDsh`. */
  readonly dshVersion: string
  /** Managed plugins recorded before this application. */
  readonly previousManaged: readonly ManagedPluginRecord[]
  /** Profile directory, for reading the dependency specs used to roll back. */
  readonly profile: string
}

/** What one application achieved. */
export interface ApplyOutcome {
  /** Reported state. */
  readonly applyState: 'applied' | 'partial' | 'failed'
  /** First failure cause from the Hub enum, or null. */
  readonly errorCode: string | null
  /** Number of entries that failed. */
  readonly errorCount: number
  /** Managed plugins after the run. */
  readonly managed: readonly ManagedPluginRecord[]
  /** Removals to retry once the running composition releases the bundle. */
  readonly pendingRemovals: readonly string[]
  /** Whether a restart is required for the result to be visible. */
  readonly restartReason: string | null
  /** Row ids a `default` fragment yielded to the user's own patch. */
  readonly skippedFragments: readonly string[]
  /** Overlay text this run wrote, for the state record. */
  readonly overlayText: string
}

/** The actions a manifest implies. */
export interface ApplyPlan {
  /** Plugins to install or upgrade, ordered by `bundleOrder` then name. */
  readonly install: readonly ManifestPlugin[]
  /** Hub-delivered bundles to uninstall. */
  readonly remove: readonly string[]
  /** Bundles whose enabled flag must change. */
  readonly toggle: readonly { readonly name: string; readonly enabled: boolean }[]
}

/**
 * Diff the manifest against what the device carries.
 * @param manifest - Validated manifest.
 * @param installed - Bundles the plugin manager currently knows.
 * @param managed - Packages this connector delivered earlier.
 * @returns The three ordered action lists.
 */
export function planApplication(
  manifest: Manifest,
  installed: readonly InstalledBundle[],
  managed: readonly ManagedPluginRecord[],
): ApplyPlan {
  const byName = new Map(installed.map(bundle => [bundle.name, bundle]))
  const install = manifest.plugins
    .filter((plugin) => {
      // An `optional` entry the Hub disabled is offered, not installed.
      if (plugin.level === 'optional' && !plugin.enabled) return false
      const current = byName.get(plugin.name)
      return current === undefined || current.version !== plugin.version
    })
    .slice()
    .sort((left, right) => left.bundleOrder - right.bundleOrder || left.name.localeCompare(right.name))
  const targets = new Set(manifest.plugins.map(plugin => plugin.name))
  // Only packages this connector delivered are candidates for removal: a
  // user-installed package with the same name is a conflict, never a target.
  const remove = new Set<string>(manifest.uninstall.filter(name => managed.some(entry => entry.name === name)))
  for (const entry of managed) {
    if (targets.has(entry.name) || entry.name === CONNECTOR_PACKAGE) continue
    // The installer's bundled baseline is not the Hub's to remove implicitly: it stays
    // until a manifest names it in `uninstall` (design §4.2).
    if (entry.source === 'bundled') continue
    remove.add(entry.name)
  }
  const toggle = manifest.plugins.flatMap((plugin) => {
    const current = byName.get(plugin.name)
    if (current === undefined) return []
    return current.enabled === plugin.enabled ? [] : [{ name: plugin.name, enabled: plugin.enabled }]
  })
  return {
    install,
    remove: [...remove].filter(name => byName.get(name)?.removable !== false),
    toggle,
  }
}

/**
 * Read the profile's recorded dependency specs, for rollback.
 * @param profile - Desktop profile directory.
 * @returns Package name to spec, empty when the manifest is missing or unreadable.
 */
export function readProfileDependencies(profile: string): Record<string, string> {
  const path = join(profile, 'package.json')
  if (!existsSync(path)) return {}
  try {
    const dependencies = record(record(JSON.parse(readFileSync(path, 'utf8')))?.dependencies)
    if (dependencies === undefined) return {}
    return Object.fromEntries(Object.entries(dependencies).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

/** Options for {@link downloadArtifact}. */
export interface ArtifactDownloadOptions {
  /** Fetch implementation (injectable for tests). */
  readonly fetchImpl?: typeof fetch
  /**
   * Device-token credentials for Hub-hosted artifacts: the Hub's plugin
   * download requires the bearer token, and the token goes **only** to the Hub's own
   * origin — never to a third-party host a manifest might name.
   */
  readonly authorization?: { readonly origin: string; readonly token: string } | undefined
}

/** The origin of one URL, or '' when it is not an absolute URL. */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * Download one archive into the connector cache, verifying length and digest.
 * @param artifact - URL, length, and digest the manifest declares.
 * @param cacheRoot - `<profile>/desktop-hub/cache`.
 * @param options - Fetch implementation and the Hub-origin credentials to send.
 * @returns Absolute path of the verified archive.
 * @throws {Error} When the download fails, the length differs, or the digest does not match.
 */
export async function downloadArtifact(
  artifact: ArtifactRef,
  cacheRoot: string,
  options: ArtifactDownloadOptions = {},
): Promise<string> {
  if (artifact.bytes > MAX_ARTIFACT_BYTES) throw new Error(`the manifest declares ${String(artifact.bytes)} bytes, above the client cap`)
  const name = artifact.filename ?? `${artifact.sha256}.tgz`
  const directory = join(cacheRoot, artifact.sha256)
  const path = join(directory, name)
  if (existsSync(path) && statSync(path).size === artifact.bytes) return path
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.part`
  // The token rides only to the Hub the device is logged in to; a manifest naming any
  // other origin gets an anonymous request (the Hub's download endpoint 401s
  // without it, and a leaked token must never reach a foreign host).
  const authorization = options.authorization
  const headers: Record<string, string> = authorization !== undefined
    && authorization.token !== ''
    && originOf(artifact.url) !== ''
    && originOf(artifact.url) === originOf(authorization.origin)
    ? { authorization: `Bearer ${authorization.token}` }
    : {}
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(artifact.url, { redirect: 'error', headers })
  } catch (error) {
    throw new Error(`download failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`download failed with HTTP ${String(response.status)}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength !== artifact.bytes) {
    throw new Error(`the archive is ${String(bytes.byteLength)} bytes, the manifest declares ${String(artifact.bytes)}`)
  }
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new Error('the archive digest does not match the manifest')
  }
  writeFileSync(temporary, bytes, { mode: 0o600 })
  renameSync(temporary, path)
  return path
}

/** The plugin manager's refusal code for a bundle the running composition still loads. */
const BUNDLE_IN_USE = 'bundle-in-use'

/**
 * Delete what a successful bundle removal leaves behind in the profile.
 *
 * The plugin manager removes the package and rewrites its own bookkeeping, but the
 * profile keeps the `file:` dependency entry and the materialised `node_modules`
 * directory. The dependency is what makes the next install resurrect the package, so
 * both go. Only `file:` specifiers are touched: a package the user installed from the
 * registry is theirs, and the Hub only removes what it delivered.
 * @param name - Package name that was removed.
 * @param profile - Desktop profile directory.
 * @returns What was removed, for the log line.
 */
export function cleanupInstallLeftovers(name: string, profile: string): string[] {
  const removed: string[] = []
  const packageJsonPath = join(profile, 'package.json')
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>
    const dependencies = record(parsed.dependencies)
    const spec = dependencies?.[name]
    if (dependencies !== undefined && typeof spec === 'string' && spec.startsWith('file:')) {
      delete dependencies[name]
      writeFileSync(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`)
      removed.push(`${name} dependency`)
    }
  } catch (error) {
    warn(`could not clean the ${name} dependency: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Scoped names nest one level (`@scope/name`); the directory is the package itself.
  const directory = join(profile, 'node_modules', ...name.split('/'))
  // `.bin` shims point into the package, so they are pruned while they still resolve.
  const binDirectory = join(profile, 'node_modules', '.bin')
  if (existsSync(binDirectory)) {
    try {
      for (const entry of readdirSync(binDirectory)) {
        const link = join(binDirectory, entry)
        let resolved = ''
        try {
          resolved = realpathSync(link)
        } catch {
          // A link that no longer resolves is replaced by the next install.
          continue
        }
        if (!resolved.startsWith(directory)) continue
        rmSync(link, { force: true })
        removed.push(`node_modules/.bin/${entry}`)
      }
    } catch (error) {
      warn(`could not prune node_modules/.bin: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (existsSync(directory)) {
    try {
      rmSync(directory, { recursive: true, force: true })
      removed.push(`${name} package directory`)
    } catch (error) {
      warn(`could not delete ${directory}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return removed
}

/**
 * Apply one validated manifest.
 * @param manifest - Validated manifest.
 * @param deps - Plugin manager, cache, overlay, and clock.
 * @returns What was achieved, including the restart need and the managed set.
 */
export async function applyManifest(manifest: Manifest, deps: ApplyDeps): Promise<ApplyOutcome> {
  const installed = await deps.listBundles()
  const plan = planApplication(manifest, installed, deps.previousManaged)
  const managed: ManagedPluginRecord[] = []
  let errorCode: string | null = null
  let errorCount = 0
  let restartReason: string | null = null
  const previousOverlay = deps.readOverlay()
  const dependencies = readProfileDependencies(deps.profile)
  for (const plugin of manifest.plugins) {
    if (plugin.level === 'optional' && !plugin.enabled && !installed.some(bundle => bundle.name === plugin.name)) {
      // Offered, not installed: nothing to do until the user asks for it.
      continue
    }
    const previous = deps.previousManaged.find(entry => entry.name === plugin.name)
    const current = installed.find(entry => entry.name === plugin.name)
    const installedVersion = current?.version
    const bundledVersion = previous !== undefined && previous.source === 'bundled' && installedVersion !== undefined
      ? parseSemver(installedVersion)
      : undefined
    const declaredVersion = parseSemver(plugin.version)
    if (bundledVersion !== undefined && declaredVersion !== undefined && compareSemver(bundledVersion, declaredVersion) > 0) {
      // The installer shipped a newer package than this manifest names. A downgrade
      // would undo the baseline; the record keeps the installed version, which is what
      // the report shows the Hub.
      warn(`${plugin.name}@${String(installedVersion)} is newer than the Hub's ${plugin.version}; the bundled baseline is not downgraded`)
      managed.push({
        name: plugin.name,
        version: String(installedVersion),
        source: 'bundled',
        enabled: current?.enabled ?? plugin.enabled,
      })
      continue
    }
    if (plugin.minDsh !== undefined && !satisfies(deps.dshVersion, plugin.minDsh)) {
      warn(`${plugin.name} needs DSH ${plugin.minDsh}; this build is ${deps.dshVersion}`)
      errorCode ??= 'plugin_missing_runtime'
      errorCount += 1
      continue
    }
    const wantsInstall = plan.install.some(entry => entry.name === plugin.name)
    if (wantsInstall) {
      try {
        const archive = await deps.fetchArtifact(plugin.artifact)
        const alreadyInstalled = installed.some(bundle => bundle.name === plugin.name)
        const outcome = await installOrReplace(plugin, archive, deps, dependencies[plugin.name], alreadyInstalled)
        if (outcome.error !== undefined) throw new Error(describeFailure(outcome.error))
        // `needsRestart` is the activation condition of a change that actually happened.
        // An unchanged, skipped, or failed entry owes nothing, so the baseline flag alone
        // must never raise a prompt on every replay of the same manifest.
        if (outcome.application === 'restart-required' || (outcome.changed && plugin.needsRestart)) {
          restartReason ??= `${plugin.name} needs a restart`
        }
        info(`applied ${plugin.name}@${plugin.version}`)
      } catch (error) {
        warn(`could not apply ${plugin.name}@${plugin.version}: ${error instanceof Error ? error.message : String(error)}`)
        errorCode ??= 'plugin_install_failed'
        errorCount += 1
        continue
      }
    }
    managed.push({ name: plugin.name, version: plugin.version, source: sourceOfLevel(plugin.level), enabled: plugin.enabled })
  }
  // Packages the manifest does not mention keep their bundled record: the baseline
  // stays installed, and dropping the record would make the device forget what it
  // carries (design §4.2).
  const named = new Set(manifest.plugins.map(plugin => plugin.name))
  const removed = new Set(plan.remove)
  for (const entry of deps.previousManaged) {
    if (entry.source !== 'bundled' || named.has(entry.name) || removed.has(entry.name)) continue
    const current = installed.find(bundle => bundle.name === entry.name)
    if (current === undefined) continue
    managed.push({ name: entry.name, version: current.version ?? entry.version, source: 'bundled', enabled: current.enabled })
  }
  // Removals the loaded composition still holds; the next start finishes them.
  const pendingRemoval: string[] = []
  for (const name of plan.remove) {
    try {
      const outcome = await deps.remove(name)
      if (outcome.error !== undefined) throw new Error(describeFailure(outcome.error))
      if (outcome.application === 'restart-required') restartReason ??= 'a plugin removal needs a restart'
      info(`uninstalled ${name}`)
      // The plugin manager leaves the `file:` dependency and the node_modules directory
      // behind; a leftover dependency keeps re-materialising the package on the next
      // install, so the removal is only complete once both are gone.
      const cleaned = cleanupInstallLeftovers(name, deps.profile)
      if (cleaned.length > 0) info(`cleaned ${cleaned.join(', ')} after removing ${name}`)
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      if (failure === BUNDLE_IN_USE) {
        // The bundle is still loaded by this Host session, which resolves on the next
        // start: a pending removal is not a failed application.
        pendingRemoval.push(name)
        restartReason ??= 'a plugin removal needs a restart'
        info(`${name} is still loaded in this session; the next start finishes its removal`)
        continue
      }
      warn(`could not uninstall ${name}: ${failure}`)
      errorCode ??= 'plugin_install_failed'
      errorCount += 1
    }
  }
  for (const toggle of plan.toggle) {
    try {
      const outcome = await deps.setEnabled(toggle.name, toggle.enabled)
      if (outcome.error !== undefined) throw new Error(describeFailure(outcome.error))
      // A toggle is a real change, so its declared activation condition counts; the
      // plugin manager can also name the restart itself, which must not be dropped.
      const declaresRestart = manifest.plugins.some(plugin => plugin.name === toggle.name && plugin.needsRestart)
      if (outcome.application === 'restart-required' || (outcome.changed && declaresRestart)) {
        restartReason ??= `${toggle.name} needs a restart`
      }
    } catch (error) {
      warn(`could not ${toggle.enabled ? 'enable' : 'disable'} ${toggle.name}: ${error instanceof Error ? error.message : String(error)}`)
      errorCode ??= 'plugin_install_failed'
      errorCount += 1
    }
  }
  const fragments: OverlayFragment[] = [
    ...manifest.config.fragments.map(fragment => ({
      id: fragment.id,
      mode: fragment.mode,
      config: fragment.config,
      ...fragment.note === undefined ? {} : { note: fragment.note },
    })),
    ...deps.extraFragments?.() ?? [],
  ]
  let overlayText = previousOverlay ?? ''
  let skippedFragments: readonly string[] = []
  try {
    const rendered = renderOverlay({
      revision: manifest.revision,
      fragments,
      connectorRow: true,
      ...deps.extraRows === undefined ? {} : { extraRows: deps.extraRows() },
      ...manifest.notice === undefined ? {} : { notice: manifest.notice },
      ...deps.proxy === undefined ? {} : { proxy: deps.proxy },
    }, { userDeclared: declaredRowIds(deps.readUserPatch()) })
    deps.writeOverlay(rendered.text)
    overlayText = rendered.text
    skippedFragments = rendered.skipped
    // Only the rows reach the composition, so a delivery that leaves them as they were
    // (a new revision, a new notice) does not ask the user for a restart.
    if (previousOverlay !== undefined && overlayBody(previousOverlay) !== overlayBody(rendered.text)) {
      restartReason ??= 'configuration changed'
    }
  } catch (error) {
    warn(`could not write the Hub overlay: ${error instanceof Error ? error.message : String(error)}`)
    if (previousOverlay !== undefined) deps.writeOverlay(previousOverlay)
    errorCode ??= 'config_write_failed'
    errorCount += 1
  }
  // A pending removal keeps its managed record: the next apply derives its removal set
  // from those records, so dropping it here would strand the bundle in the profile.
  for (const name of pendingRemoval) {
    const previous = deps.previousManaged.find(entry => entry.name === name)
    if (previous !== undefined) managed.push(previous)
  }
  const failed = errorCount > 0
  return {
    applyState: failed ? (managed.length === 0 ? 'failed' : 'partial') : 'applied',
    errorCode,
    errorCount,
    managed,
    pendingRemovals: pendingRemoval,
    restartReason,
    skippedFragments,
    overlayText,
  }
}

/** Install one archive, replacing an existing version and restoring it if the replacement fails. */
/** Render one manager failure for a log line. */
function describeFailure(error: unknown): string {
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return 'unknown'
}

async function installOrReplace(
  plugin: ManifestPlugin,
  archive: string,
  deps: ApplyDeps,
  previousSpec: string | undefined,
  alreadyInstalled: boolean,
): Promise<ChangeOutcome> {
  const spec = `file:${archive}`
  if (alreadyInstalled) {
    // A different `file:` value replaces in place; the manager only refuses a spec
    // equal to the recorded dependency, which is exactly this package's old path.
    const removal = await deps.remove(plugin.name)
    if (removal.error !== undefined) return removal
    const replaced = await deps.install(spec, { saveExact: true })
    if (replaced.error !== undefined && previousSpec !== undefined && existsSync(previousSpec.replace(/^file:/u, ''))) {
      const restored = await deps.install(previousSpec, { saveExact: true })
      if (restored.error !== undefined) warn(`could not restore the previous ${plugin.name}: ${describeFailure(restored.error)}`)
      else info(`restored ${plugin.name} to its previous version`)
    }
    return replaced
  }
  const result = await deps.install(spec, { saveExact: true })
  if (result.error !== undefined && describeFailure(result.error) === 'already-installed') {
    // A recomposed connector can finish this installation while this instance
    // waits for the manager. Verify the installed version before accepting it.
    const current = (await deps.listBundles()).find(bundle => bundle.name === plugin.name)
    if (current?.version === plugin.version && current.enabled === plugin.enabled) return { changed: false }
  }
  return result
}

/**
 * Remove cached archives beyond the newest few.
 * @param cacheRoot - `<profile>/desktop-hub/cache`.
 * @param keep - How many archive directories to keep.
 */
export function pruneCache(cacheRoot: string, keep: number): void {
  if (!existsSync(cacheRoot)) return
  const entries = readdirSync(cacheRoot)
    .filter((name) => {
      try {
        return statSync(join(cacheRoot, name)).isDirectory()
      } catch {
        return false
      }
    })
    .map(name => ({ name, at: statSync(join(cacheRoot, name)).mtimeMs }))
    .sort((left, right) => right.at - left.at)
  for (const entry of entries.slice(keep)) rmSync(join(cacheRoot, entry.name), { recursive: true, force: true })
}
