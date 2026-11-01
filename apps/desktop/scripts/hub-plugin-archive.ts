/**
 * Archive entries of one Hub plugin: the delivered files, plus exactly the runtime
 * dependencies the plugin declares in `bundleDependencies`.
 *
 * A Hub plugin's profile unpacks it without a package manager, so a dependency the
 * plugin needs at runtime has to travel inside the archive. The desktop packaging
 * step and its regression both read this module, so the rule has one home.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** One file written into the plugin archive. */
export interface ArchiveEntry {
  /** Path inside the archive, starting with `package/`. */
  readonly path: string
  /** File contents. */
  readonly contents: Buffer
}

/** Files one Hub plugin archive carries: sources stay out of the delivered package. */
const PLUGIN_ROOT_FILES = ['package.json', 'cordis.patch.yml', 'manifest.schema.json', 'build-info.json', 'README.md']

/**
 * npm package ids one plugin directory ships inside `node_modules`.
 *
 * The profile unpacks a Hub plugin without a package manager, so a runtime
 * dependency it cannot install has to travel inside the archive. Only the ids the
 * plugin declares in `bundleDependencies` are carried; everything else in
 * `node_modules` (dev and peer links of the build checkout) stays out.
 * @param directory - plugin package directory.
 * @returns declared ids, or an empty set when the plugin bundles nothing.
 */
function bundledModuleIds(directory: string): ReadonlySet<string> {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  } catch {
    return new Set()
  }
  if (typeof manifest !== 'object' || manifest === null) return new Set()
  const declared = Reflect.get(manifest, 'bundleDependencies') ?? Reflect.get(manifest, 'bundledDependencies')
  if (!Array.isArray(declared)) return new Set()
  return new Set(declared.filter((id): id is string => typeof id === 'string' && id !== ''))
}

/**
 * Collect the shipped files of one Hub plugin directory, in a stable order.
 * Exported for the packaging regression that checks declared bundled dependencies
 * really travel inside the archive.
 */
export function pluginFiles(directory: string, prefix = '', bundled?: ReadonlySet<string>): ArchiveEntry[] {
  const bundledIds = bundled ?? bundledModuleIds(directory)
  const entries: ArchiveEntry[] = []
  for (const name of readdirSync(directory).sort()) {
    if (prefix === '' && !PLUGIN_ROOT_FILES.includes(name) && name !== 'lib' && name !== 'node_modules') continue
    const path = join(directory, name)
    const relativePath = prefix === '' ? name : `${prefix}/${name}`
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules') {
        entries.push(...bundledModuleFiles(directory, bundledIds))
        continue
      }
      entries.push(...pluginFiles(path, relativePath, bundledIds))
      continue
    }
    entries.push({ path: `package/${relativePath}`, contents: readFileSync(path) })
  }
  return entries
}

/**
 * Collect the declared bundled packages of one plugin directory.
 * @param directory - plugin package directory holding `node_modules`.
 * @param bundled - package ids to carry.
 * @returns archive entries for exactly those packages.
 */
function bundledModuleFiles(directory: string, bundled: ReadonlySet<string>): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  const root = join(directory, 'node_modules')
  if (bundled.size === 0 || !existsSync(root)) return entries
  const present = new Set<string>()
  for (const name of readdirSync(root).sort()) {
    const candidates = name.startsWith('@')
      ? readdirSync(join(root, name)).sort().map(child => `${name}/${child}`)
      : [name]
    for (const id of candidates) {
      if (!bundled.has(id)) continue
      present.add(id)
      entries.push(...collectTree(join(root, id), `node_modules/${id}`))
    }
  }
  // A declared runtime dependency that is not installed here would ship a plugin that
  // fails to load on the profile; fail the build instead of producing that archive.
  const absent = [...bundled].filter(id => !present.has(id))
  if (absent.length > 0) {
    throw new Error(`desktop hub runtime: ${directory} declares bundled dependencies that are not installed: ${absent.join(', ')}`)
  }
  return entries
}

/**
 * Collect one directory tree verbatim.
 * @param directory - directory to walk.
 * @param relativePath - path the tree occupies inside the archive.
 * @returns archive entries, in a stable order.
 */
function collectTree(directory: string, relativePath: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name)
    const nested = `${relativePath}/${name}`
    if (statSync(path).isDirectory()) {
      entries.push(...collectTree(path, nested))
      continue
    }
    entries.push({ path: `package/${nested}`, contents: readFileSync(path) })
  }
  return entries
}
