/**
 * The installer's bundled plugins: the baseline a fresh desktop profile starts with.
 *
 * The packaging step copies the archives beside `bundled-plugins.json` into
 * `resources/runtime/hub-plugins/`, and the shell hands that directory to the
 * Host through `DSH_HUB_BUNDLED_DIR`. This module is the only applier: on every
 * start it installs what the profile lacks, upgrades a package the installer
 * ships at a higher version, and records each result with `source: 'bundled'`
 * so the Hub can count them (design §4.2).
 *
 * Four rules keep the baseline from fighting the Hub or the user:
 * - A Hub manifest that names the package outranks the baseline: the manifest's
 *   own version installs, its enabled flag applies, and an explicit uninstall is
 *   remembered so the next start does not put the package back.
 * - A package installed at a version above the bundled one is never downgraded.
 * - The user may disable a non-core bundled plugin; only `core` is forced on.
 * - Sign-in is irrelevant: the archives are local, so a first start installs
 *   them before any account exists.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { info, warn } from './log.ts'
import type { ChangeOutcome, InstalledBundle } from './manifest.ts'
import { compareSemver, parseSemver } from './semver.ts'
import type { ManagedPluginRecord } from './state.ts'

/** Manifest the packaging step writes beside the bundled archives. */
export const BUNDLED_PLUGIN_MANIFEST = 'bundled-plugins.json'

/** Profile directory holding the staged archives this connector installs from. */
const STAGE_DIRECTORY = 'bundled'

/** npm package name form the plugin manager accepts. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

/** One third-party plugin the installer carries. */
export interface BundledPluginDeclaration {
  /** npm package name. */
  readonly package: string
  /** Exact version the archive's own manifest declares. */
  readonly version: string
  /** Archive file name beside the manifest. */
  readonly file: string
  /** Lowercase hex SHA-256 of the archive bytes. */
  readonly sha256: string
  /** Delivery level: `core` cannot be disabled; `default` and `optional` belong to the user. */
  readonly level: 'core' | 'default' | 'optional'
}

/** Narrow an unknown value to a plain record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read the installer's bundled-plugin manifest.
 * @param directory - `resources/runtime/hub-plugins` of the running application.
 * @returns Declarations in manifest order; empty when the build shipped none.
 * @throws {Error} When the manifest exists but does not describe valid packages.
 */
export function readBundledPluginManifest(directory: string): BundledPluginDeclaration[] {
  const path = join(directory, BUNDLED_PLUGIN_MANIFEST)
  if (!existsSync(path)) return []
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(value)) throw new Error(`hub bundled plugins: ${path} must hold an array`)
  return value.map((entry: unknown, index: number) => {
    const item = record(entry)
    const name = item?.package
    const version = item?.version
    const file = item?.file
    const sha256 = item?.sha256
    const level = item?.level
    if (typeof name !== 'string' || !PACKAGE_NAME.test(name) || typeof version !== 'string' || version === ''
      || typeof file !== 'string' || file === '' || file.includes('/') || file.includes('\\') || file.includes('..')
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)
      || (level !== 'core' && level !== 'default' && level !== 'optional')) {
      throw new Error(`hub bundled plugins: ${path} entry ${String(index)} is not a valid declaration`)
    }
    return { package: name, version, file, sha256, level }
  })
}

/** Version order of two installed/declared versions; unparsable text compares as older. */
function versionOrder(left: string, right: string): number {
  const parsedLeft = parseSemver(left)
  const parsedRight = parseSemver(right)
  if (parsedLeft === undefined || parsedRight === undefined) return left === right ? 0 : -1
  return compareSemver(parsedLeft, parsedRight)
}

/** Everything one activation reaches outside itself. */
export interface BundledActivationDeps {
  /** Directory the packaging step filled: archives plus `bundled-plugins.json`. */
  readonly directory: string
  /** Desktop profile directory; staged archives live under `desktop-hub/bundled`. */
  readonly profile: string
  /** Current bundles. */
  readonly listBundles: () => Promise<readonly InstalledBundle[]>
  /** Install one `file:` spec and select it. */
  readonly install: (spec: string, options?: { readonly saveExact?: boolean }) => Promise<ChangeOutcome>
  /** Enable or disable one bundle. */
  readonly setEnabled: (name: string, enabled: boolean) => Promise<ChangeOutcome>
  /** Bundled packages an explicit manifest uninstall removed; the baseline leaves them out. */
  readonly suppressed: readonly string[]
}

/** What one activation achieved. */
export interface BundledActivation {
  /** Packages the bundled manifest declares, whether or not this run installed them. */
  readonly declared: readonly string[]
  /** Records to keep for the declared packages, in manifest order. */
  readonly records: readonly ManagedPluginRecord[]
  /** How many declarations the plugin manager refused. */
  readonly failures: number
  /** Why a restart is needed before the change is visible, or null. */
  readonly restartReason: string | null
}

/**
 * Copy one declared archive into the profile and verify it there.
 *
 * The installer directory is read-only and outside the profile, so the plugin
 * manager gets a `file:` spec inside the profile it can keep. The digest is
 * checked against the manifest before anything is written: a build that shipped
 * the wrong bytes fails here instead of installing them.
 * @param plugin - Declaration to stage.
 * @param deps - Directory and profile the archive comes from and goes to.
 * @returns Absolute path of the staged archive.
 * @throws {Error} When the archive is missing or its digest differs.
 */
function stageArchive(plugin: BundledPluginDeclaration, deps: BundledActivationDeps): string {
  const source = join(deps.directory, plugin.file)
  if (!existsSync(source)) throw new Error(`${plugin.file} is missing from ${deps.directory}`)
  const bytes = readFileSync(source)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== plugin.sha256) {
    throw new Error(`${plugin.file} has SHA-256 ${digest}, the bundled manifest declares ${plugin.sha256}`)
  }
  const directory = join(deps.profile, 'desktop-hub', STAGE_DIRECTORY)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, plugin.file)
  if (!existsSync(path) || readFileSync(path).compare(bytes) !== 0) writeFileSync(path, bytes, { mode: 0o600 })
  return path
}

/**
 * Apply the bundled plugin set to one profile.
 *
 * Idempotent: a package already at the declared version is left alone, and the
 * records it returns are what the report should carry afterwards.
 * @param deps - Bundles, plugin manager, and the installer's directory.
 * @returns Records for the declared packages plus anything that needs a restart.
 * @throws {Error} When the manifest itself is unreadable.
 */
export async function activateBundledPlugins(deps: BundledActivationDeps): Promise<BundledActivation> {
  const declarations = readBundledPluginManifest(deps.directory)
  const declared = declarations.map(plugin => plugin.package)
  if (declarations.length === 0) return { declared, records: [], failures: 0, restartReason: null }
  const installed = await deps.listBundles()
  const records: ManagedPluginRecord[] = []
  let failures = 0
  let restartReason: string | null = null
  for (const plugin of declarations) {
    if (deps.suppressed.includes(plugin.package)) {
      info(`${plugin.package} stays removed: a Hub manifest uninstalled it`)
      continue
    }
    let bundle = installed.find(entry => entry.name === plugin.package)
    // Install when absent, or when the installer ships a higher version. A profile at
    // an equal or higher version keeps it: the Hub may have upgraded the package.
    if (bundle === undefined || bundle.version === undefined || versionOrder(bundle.version, plugin.version) < 0) {
      try {
        const outcome = await deps.install(`file:${stageArchive(plugin, deps)}`, { saveExact: true })
        if (outcome.error !== undefined) throw new Error(String(outcome.error))
        info(`installed bundled ${plugin.package}@${plugin.version}`)
        restartReason ??= `${plugin.package} was installed from the installer`
        bundle = { name: plugin.package, version: plugin.version, enabled: true }
      } catch (error) {
        // A recomposed connector may have finished the same install while this instance waited.
        const current = (await deps.listBundles()).find(entry => entry.name === plugin.package)
        if (current?.version !== undefined && versionOrder(current.version, plugin.version) >= 0) {
          bundle = current
        } else {
          warn(`could not install bundled ${plugin.package}@${plugin.version}: ${error instanceof Error ? error.message : String(error)}`)
          failures += 1
          continue
        }
      }
    }
    const version = bundle.version ?? plugin.version
    if (versionOrder(version, plugin.version) > 0) {
      warn(`${plugin.package}@${version} is newer than the bundled ${plugin.version}; keeping the installed version`)
    }
    let enabled = bundle.enabled
    if (plugin.level === 'core' && !enabled) {
      try {
        const outcome = await deps.setEnabled(plugin.package, true)
        if (outcome.error !== undefined) throw new Error(String(outcome.error))
        enabled = true
        restartReason ??= `${plugin.package} is core and was re-enabled`
      } catch (error) {
        warn(`could not enable bundled core ${plugin.package}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    records.push({ name: plugin.package, version, source: 'bundled', enabled })
  }
  return { declared, records, failures, restartReason }
}

/**
 * Replace the bundled records in one managed list.
 *
 * Records for packages the manifest no longer declares stay: the package is still
 * installed, and dropping the record would report it as something the Hub owns.
 * @param previous - Records the state holds now.
 * @param records - Records this activation produced.
 * @param declared - Every package name the bundled manifest declares.
 * @returns The managed list with the bundled entries replaced.
 */
export function mergeBundledRecords(
  previous: readonly ManagedPluginRecord[],
  records: readonly ManagedPluginRecord[],
  declared: ReadonlySet<string>,
): ManagedPluginRecord[] {
  return [...previous.filter(entry => !declared.has(entry.name)), ...records]
}

/** Bundled packages whose declared dependencies are not materialised in the profile yet. */
export interface MissingBundledDependencies {
  /** Bundled package names that need their dependencies resolved. */
  readonly packages: readonly string[]
  /** Dependency package names the profile is missing (for the log line). */
  readonly dependencies: readonly string[]
}

/**
 * Package names a bundled plugin declares but the profile's node_modules lacks.
 *
 * The installer lays the archives down before the Host starts, which cannot
 * materialise a plugin's own dependencies (the pilots pull their SDK and platform
 * binaries that way). The check is a directory probe, so a resolved profile costs
 * nothing at startup.
 * @param profile - Desktop profile directory.
 * @param records - Bundled records the connector tracks.
 * @returns The packages and dependency names still missing.
 */
export function missingBundleDependencies(
  profile: string,
  records: readonly ManagedPluginRecord[],
): MissingBundledDependencies {
  const packages: string[] = []
  const dependencies: string[] = []
  for (const entry of records) {
    if (entry.source !== 'bundled') continue
    const manifestPath = join(profile, 'node_modules', ...entry.name.split('/'), 'package.json')
    let declared: Record<string, unknown> | undefined
    try {
      declared = record(JSON.parse(readFileSync(manifestPath, 'utf8')))
    } catch {
      // A package the profile does not carry is not this check's subject.
      continue
    }
    const names = ['dependencies', 'optionalDependencies'].flatMap((field) => {
      const section = record(declared?.[field])
      return section === undefined ? [] : Object.keys(section)
    })
    const absent = names.filter((name) => {
      try {
        return !statSync(join(profile, 'node_modules', ...name.split('/'))).isDirectory()
      } catch {
        return true
      }
    })
    if (absent.length === 0) continue
    packages.push(entry.name)
    dependencies.push(...absent)
  }
  return { packages, dependencies: [...new Set(dependencies)] }
}

/** What one background dependency pass reaches outside itself. */
export interface BundledDependencyDeps {
  /** Desktop profile directory. */
  readonly profile: string
  /** Bundled records the connector tracks. */
  readonly records: readonly ManagedPluginRecord[]
  /** Run the profile's package install; resolves true on success. */
  readonly install: () => Promise<boolean>
  /** Reload the composition once, so every plugin whose dependency now exists activates together. */
  readonly reload: () => Promise<void>
}

/** What one background dependency pass achieved. */
export interface BundledDependencyOutcome {
  /** What was missing before the pass. */
  readonly missing: MissingBundledDependencies
  /** Whether the package install ran and succeeded. */
  readonly installed: boolean
  /** Whether the connector asked for the one composition reload. */
  readonly reloaded: boolean
}

/**
 * Resolve the bundled plugins' dependencies after the Host is already serving.
 *
 * The install runs in the background so the first window does not wait for it; a
 * failure (offline, a registry outage) is only a warning, and the next start tries
 * again. One reload follows a successful install — the packages are already part
 * of the profile, so a single recomposition activates all of them instead of one
 * nested reload per package.
 * @param deps - Profile, tracked records, and the install/reload actions.
 * @returns What was missing and what the pass achieved.
 */
export async function resolveBundledDependencies(deps: BundledDependencyDeps): Promise<BundledDependencyOutcome> {
  const missing = missingBundleDependencies(deps.profile, deps.records)
  if (missing.packages.length === 0) return { missing, installed: false, reloaded: false }
  info(`resolving dependencies for ${missing.packages.join(', ')} in the background (${missing.dependencies.join(', ')})`)
  if (!await deps.install()) {
    warn('bundled plugin dependencies are still unresolved; the next start retries')
    return { missing, installed: false, reloaded: false }
  }
  await deps.reload()
  info(`bundled plugin dependencies resolved; ${missing.packages.join(', ')} activated by one composition reload`)
  return { missing, installed: true, reloaded: true }
}
