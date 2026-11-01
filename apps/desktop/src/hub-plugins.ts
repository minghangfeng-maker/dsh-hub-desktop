/**
 * Bundled Hub plugins: first-start activation of the plugin packages the installer carries.
 *
 * The Hub connector ships with the installer version rather than through Hub
 * delivery, so a fresh install must be able to activate it without a package
 * manager, a registry, or a network round trip. The build packs each plugin as an
 * npm package archive and writes a manifest beside it; this module installs the
 * archive into the desktop profile, records the package as a profile dependency
 * of the same archive, and adds it to the profile's bundle list so the Host
 * composes it as a core plugin.
 *
 * The profile directory is the same one the plugin manager owns, so every write
 * happens under the caller's profile lock and the previous copy of a bundled
 * plugin is replaced only when its packaged version differs.
 *
 * The same pass installs the third-party plugins the installer carries
 * (`bundled-plugins.json`): installing them later from inside the Host would
 * reload the composition once per package, so the shell lays them down before
 * the Host starts and the connector only records them.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readProfileManifest, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { extractPackageArchive } from './tar-archive.ts'
import { HUB_OVERLAY_FILENAME } from './hub-overlay.ts'

/** Manifest the build writes beside the packaged archives, under `resources/runtime/hub-plugins`. */
export const HUB_PLUGIN_MANIFEST = 'hub-plugins.json'

/** Manifest the packaging step writes beside the third-party archives. */
export const BUNDLED_PLUGIN_MANIFEST = 'bundled-plugins.json'

/** Profile-side record of the bundled plugins this install activated. */
export const HUB_PLUGIN_STATE = 'hub-plugins.json'

/** Row id the placeholder connector bundle contributes, which the seeded overlay configures. */
const PLACEHOLDER_CONNECTOR_ID = 'hub-connector'

/** One plugin package the installer carries. */
export interface BundledHubPlugin {
  /** npm package name. */
  readonly name: string
  /** Package version; a different installed version is replaced. */
  readonly version: string
  /** Archive filename inside the manifest directory. */
  readonly file: string
}

/** Result of activating one bundled plugin. */
export interface HubPluginActivation {
  /** npm package name. */
  readonly name: string
  /** Packaged version. */
  readonly version: string
  /** `installed` when this start wrote the package, `current` when the profile already had it. */
  readonly state: 'installed' | 'current'
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

/**
 * Read the build's bundled-plugin manifest.
 * @param directory - `resources/runtime/hub-plugins` of the installed application.
 * @returns Declared plugins in manifest order; empty when the directory or manifest is absent.
 * @throws {Error} When the manifest exists but does not describe valid packages.
 */
export function readBundledHubPlugins(directory: string): BundledHubPlugin[] {
  const path = join(directory, HUB_PLUGIN_MANIFEST)
  if (!existsSync(path)) return []
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Array.isArray((value as { plugins?: unknown }).plugins)) {
    throw new Error(`desktop hub plugin: ${path} must hold a plugins array`)
  }
  return (value as { plugins: unknown[] }).plugins.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`desktop hub plugin: ${path} contains a non-object plugin entry`)
    }
    const record = entry as Record<string, unknown>
    const { name, version, file } = record
    if (typeof name !== 'string' || !PACKAGE_NAME.test(name) || typeof version !== 'string' || version === ''
      || typeof file !== 'string' || file === '' || file.includes('/') || file.includes('\\') || file.includes('..')) {
      throw new Error(`desktop hub plugin: ${path} contains an invalid plugin entry`)
    }
    return { name, version, file }
  })
}

/** Read one package version without trusting anything else in the manifest. */
function installedVersion(directory: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (typeof value !== 'object' || value === null) return undefined
    const version = (value as { version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/** Whether a profile dependency spec already points at the archive this build carries. */
function archiveSpec(file: string): string {
  return `file:./hub-plugins/${file}`
}

/**
 * Activate every bundled plugin in one profile directory.
 * @param options - Packaged archive directory and the desktop profile directory.
 * @returns What happened to each declared plugin, in manifest order.
 * @throws {Error} When an archive cannot be read or the profile manifest is malformed.
 */
export function activateBundledHubPlugins(options: { readonly source: string; readonly profile: string }): HubPluginActivation[] {
  const plugins = readBundledHubPlugins(options.source)
  if (plugins.length === 0) return []
  const manifestPath = join(options.profile, 'package.json')
  const manifest = existsSync(manifestPath) ? readProfileManifest('dsh', options.profile) : undefined
  const dependencies: Record<string, string> = { ...manifest?.dependencies }
  const bundles: string[] = [...manifest?.dsh?.profile?.bundles ?? []]
  const archiveDirectory = join(options.profile, 'hub-plugins')
  mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 })
  const activations: HubPluginActivation[] = []
  for (const plugin of plugins) {
    const target = join(options.profile, 'node_modules', ...plugin.name.split('/'))
    const current = installedVersion(target) === plugin.version
    if (!current) {
      const archive = readFileSync(join(options.source, plugin.file))
      const files = extractPackageArchive(archive)
      rmSync(target, { recursive: true, force: true })
      for (const file of files) {
        const destination = join(target, ...file.path.split('/'))
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
        writeFileSync(destination, file.contents, { mode: 0o644 })
      }
    }
    writeFileSync(join(archiveDirectory, plugin.file), readFileSync(join(options.source, plugin.file)), { mode: 0o600 })
    dependencies[plugin.name] = archiveSpec(plugin.file)
    if (!bundles.includes(plugin.name)) bundles.push(plugin.name)
    activations.push({ name: plugin.name, version: plugin.version, state: current ? 'current' : 'installed' })
  }
  if (manifest !== undefined) {
    writeProfileManifest(options.profile, {
      ...manifest,
      dependencies,
      dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
    })
    writeActivationRecords(options.profile, activations)
  }
  return activations
}

/** One entry of the profile-side activation record. */
interface ActivationRecord {
  /** npm package name. */
  readonly name: string
  /** Version this install wrote. */
  readonly version: string
}

/**
 * Read the packages a previous run activated.
 * @param profile - Desktop profile directory.
 * @returns Records as written; empty when the file is absent or unreadable.
 */
function readActivationRecords(profile: string): ActivationRecord[] {
  const path = join(profile, HUB_PLUGIN_STATE)
  if (!existsSync(path)) return []
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof value !== 'object' || value === null) return []
    const plugins = (value as { plugins?: unknown }).plugins
    if (!Array.isArray(plugins)) return []
    return plugins.flatMap((entry): ActivationRecord[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const record = entry as { name?: unknown; version?: unknown }
      if (typeof record.name !== 'string' || !PACKAGE_NAME.test(record.name) || typeof record.version !== 'string') return []
      return [{ name: record.name, version: record.version }]
    })
  } catch {
    return []
  }
}

/**
 * Record activations without dropping what other bundled sets already recorded.
 * @param profile - Desktop profile directory.
 * @param activations - Packages this run activated, in manifest order.
 */
function writeActivationRecords(profile: string, activations: readonly ActivationRecord[]): void {
  const merged = new Map(readActivationRecords(profile).map(record => [record.name, record]))
  for (const activation of activations) merged.set(activation.name, { name: activation.name, version: activation.version })
  writeFileSync(join(profile, HUB_PLUGIN_STATE), `${JSON.stringify({
    schemaVersion: 1,
    plugins: [...merged.values()],
  }, undefined, 2)}\n`, { mode: 0o600 })
}

/** Third-party plugins the installer carries, as `bundled-plugins.json` declares them. */
export interface BundledThirdPartyPlugin {
  /** npm package name. */
  readonly name: string
  /** Exact version the archive carries. */
  readonly version: string
  /** Archive file name beside the manifest. */
  readonly file: string
  /** Lowercase hex SHA-256 of the archive bytes. */
  readonly sha256: string
  /** `core` is always enabled; `default` and `optional` belong to the user. */
  readonly level: 'core' | 'default' | 'optional'
}

/** Result of activating one third-party bundled plugin. */
export interface BundledThirdPartyActivation {
  /** npm package name. */
  readonly name: string
  /** Version in the profile after the pass. */
  readonly version: string
  /** `installed` (or upgraded), `current`, `kept-newer`, or skipped because a manifest removed it. */
  readonly state: 'installed' | 'current' | 'kept-newer' | 'skipped-removed'
}

/** Compare two versions; a release outranks its prereleases. Missing numeric parts count as zero. */
function compareVersions(left: string, right: string): number {
  const [leftCore = '', leftPre] = left.split('-', 2)
  const [rightCore = '', rightPre] = right.split('-', 2)
  const leftParts = leftCore.split('.').map(part => Number.parseInt(part, 10) || 0)
  const rightParts = rightCore.split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  if (leftPre === undefined && rightPre === undefined) return 0
  if (leftPre === undefined) return 1
  if (rightPre === undefined) return -1
  return leftPre === rightPre ? 0 : (leftPre < rightPre ? -1 : 1)
}

/**
 * Read the third-party plugin declarations the installer carries.
 * @param directory - `resources/runtime/hub-plugins` of the running application.
 * @returns Declarations in manifest order; empty when the build ships none.
 * @throws {Error} When the manifest exists but does not describe valid packages.
 */
export function readBundledThirdPartyPlugins(directory: string): BundledThirdPartyPlugin[] {
  const path = join(directory, BUNDLED_PLUGIN_MANIFEST)
  if (!existsSync(path)) return []
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(value)) throw new Error(`desktop hub plugin: ${path} must hold an array`)
  return value.map((entry: unknown) => {
    const record = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : undefined
    const name = record?.package
    const version = record?.version
    const file = record?.file
    const sha256 = record?.sha256
    const level = record?.level
    if (typeof name !== 'string' || !PACKAGE_NAME.test(name) || typeof version !== 'string' || version === ''
      || typeof file !== 'string' || file === '' || file.includes('/') || file.includes('\\') || file.includes('..')
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)
      || (level !== 'core' && level !== 'default' && level !== 'optional')) {
      throw new Error(`desktop hub plugin: ${path} contains an invalid third-party plugin entry`)
    }
    return { name, version, file, sha256, level }
  })
}

/**
 * Packages a Hub manifest explicitly removed, read from the connector's state.
 *
 * The connector owns that decision; the shell only avoids putting the package
 * back before the Host starts, which would undo the Hub's uninstall.
 * @param profile - Desktop profile directory.
 * @returns Package names; empty when the connector never recorded a removal.
 */
function removedBundledPackages(profile: string): Set<string> {
  try {
    const value: unknown = JSON.parse(readFileSync(join(profile, 'desktop-hub', 'state.json'), 'utf8'))
    const removed = typeof value === 'object' && value !== null ? (value as { bundledRemovals?: unknown }).bundledRemovals : undefined
    return new Set(Array.isArray(removed) ? removed.filter((name): name is string => typeof name === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * Activate the third-party plugins the installer carries, before the Host starts.
 *
 * Installing them from inside the running Host triggers a composition reload per
 * package; a chain of those reloads leaves later packages installed but not
 * loaded. The shell owns the profile before the Host composes it,
 * so it extracts the archives here instead — the Host's first composition already
 * carries every bundled plugin, and the connector only records them.
 *
 * The same rules as the connector's fallback apply: an installed higher version
 * is kept; a Hub manifest's removal wins; a non-core package the user disabled
 * stays out of the bundle list.
 * @param options - Packaged archive directory and the desktop profile directory.
 * @returns What happened to each declared plugin, in manifest order.
 * @throws {Error} When the manifest is invalid, an archive is missing, or its digest differs.
 */
export function activateBundledThirdPartyPlugins(options: {
  readonly source: string
  readonly profile: string
}): BundledThirdPartyActivation[] {
  const plugins = readBundledThirdPartyPlugins(options.source)
  if (plugins.length === 0) return []
  const manifest = readProfileManifest('dsh', options.profile)
  const dependencies: Record<string, string> = { ...manifest.dependencies }
  const bundles: string[] = [...manifest.dsh?.profile?.bundles ?? []]
  const records = new Map(readActivationRecords(options.profile).map(record => [record.name, record]))
  const removed = removedBundledPackages(options.profile)
  const archiveDirectory = join(options.profile, 'hub-plugins')
  mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 })
  const activations: BundledThirdPartyActivation[] = []
  for (const plugin of plugins) {
    if (removed.has(plugin.name)) {
      activations.push({ name: plugin.name, version: plugin.version, state: 'skipped-removed' })
      continue
    }
    const target = join(options.profile, 'node_modules', ...plugin.name.split('/'))
    const installed = installedVersion(target)
    // A package the Hub upgraded outranks the installer's copy.
    if (installed !== undefined && compareVersions(installed, plugin.version) > 0) {
      activations.push({ name: plugin.name, version: installed, state: 'kept-newer' })
      continue
    }
    const current = installed === plugin.version
    if (!current) {
      const archive = readFileSync(join(options.source, plugin.file))
      if (createHash('sha256').update(archive).digest('hex') !== plugin.sha256) {
        throw new Error(`desktop hub plugin: ${plugin.file} does not match its declared SHA-256`)
      }
      const files = extractPackageArchive(archive)
      rmSync(target, { recursive: true, force: true })
      for (const entry of files) {
        const destination = join(target, ...entry.path.split('/'))
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
        writeFileSync(destination, entry.contents, { mode: 0o644 })
      }
      writeFileSync(join(archiveDirectory, plugin.file), archive, { mode: 0o600 })
    }
    dependencies[plugin.name] = archiveSpec(plugin.file)
    // `core` is always on; for the rest, a previously activated package that is no
    // longer in the bundle list is one the user disabled, and it stays that way.
    const userDisabled = plugin.level !== 'core' && records.has(plugin.name) && !bundles.includes(plugin.name)
    if (!userDisabled && !bundles.includes(plugin.name)) bundles.push(plugin.name)
    activations.push({ name: plugin.name, version: plugin.version, state: current ? 'current' : 'installed' })
    records.set(plugin.name, { name: plugin.name, version: plugin.version })
  }
  writeProfileManifest(options.profile, {
    ...manifest,
    dependencies,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
  })
  writeActivationRecords(options.profile, [...records.values()])
  return activations
}

/**
 * List the bundled plugins a profile currently records.
 * @param profile - Desktop profile directory.
 * @returns Package names from the profile's activation record; empty when the profile has none.
 */
export function installedHubPlugins(profile: string): string[] {
  const path = join(profile, HUB_PLUGIN_STATE)
  if (!existsSync(path)) return []
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof value !== 'object' || value === null) return []
    const plugins = (value as { plugins?: unknown }).plugins
    if (!Array.isArray(plugins)) return []
    return plugins.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const name = (entry as { name?: unknown }).name
      return typeof name === 'string' && PACKAGE_NAME.test(name) ? [name] : []
    })
  } catch {
    return []
  }
}

/**
 * Write the Hub overlay the Host applies as `--patch`, unless the profile already has one.
 *
 * The overlay is the Hub's configuration channel; this seed only guarantees that a
 * fresh install carries a working file and that the bundled connector is configured
 * through it. The Hub connector replaces the file once it delivers its own manifest.
 * @param profile - Desktop profile directory.
 * @param options - Whether the placeholder connector is installed and the Hub origin to record.
 * @returns The overlay path that now exists, or undefined when nothing was written.
 */
export function seedHubOverlay(
  profile: string, options: { readonly connectorInstalled: boolean; readonly hubOrigin: string },
): string | undefined {
  const path = join(profile, HUB_OVERLAY_FILENAME)
  if (existsSync(path)) return path
  const lines = [
    '# DSH Hub overlay for the desktop profile.',
    '#',
    '# The desktop Host passes this file to the profile as a `--patch` overlay, so its',
    '# rows outrank the profile patch and every bundle layer. The Hub connector replaces',
    '# this document with the configuration a Hub manifest delivers; the desktop shell',
    '# only seeds it so a fresh install carries a present, valid overlay.',
  ]
  if (options.connectorInstalled) {
    lines.push('', `- id: ${PLACEHOLDER_CONNECTOR_ID}`, '  config:', '    configSource: overlay')
  }
  if (options.hubOrigin !== '') lines.push('', `# Hub origin: ${options.hubOrigin}`)
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
  return path
}
