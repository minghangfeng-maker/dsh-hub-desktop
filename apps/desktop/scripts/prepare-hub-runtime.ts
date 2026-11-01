/**
 * Prepare the Hub-owned runtime additions for one Desktop target.
 *
 * Runs after `prepare:runtime`, which clears and owns `runtime/`:
 *
 * 1. the bundled PowerShell 7 LTS tree under `runtime/pwsh/<version>/`, fetched from
 *    the official release (mirrors first) and verified against the pinned SHA-256;
 * 2. the bundled Hub plugin archives under `runtime/hub-plugins/`, packed from
 *    `hub/plugins/*` together with the manifest the shell installs them from.
 *
 * Both directories ship inside `resources/runtime` through the existing
 * `extraResources` copy, so no packaging configuration needs another entry.
 *
 *   pnpm --filter @deepseek-ai/dsh-desktop run prepare:hub-runtime
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import extractZip from 'extract-zip'
import { DESKTOP_BRANDING } from '../hub/branding.mjs'
import { BRAND_SOURCE, ICON_ARTBOARDS, standaloneArtboard } from '../hub/brand-artboard.mjs'
import { resolveClientHalf, svgDataUrl, wrapClientHalf } from '../hub/hub-plugin-client.mjs'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { packagingStep } from './packaging-step.mjs'
import { extractPackageArchive } from '../src/tar-archive.ts'

/** Application directory; `import.meta.dirname` keeps this file runnable from any cwd. */
function appRoot(): string {
  return resolve(import.meta.dirname, '..')
}

const PWSH_LOCK = join(appRoot(), 'hub', 'pwsh-runtime.json')

const DOWNLOAD_TIMEOUT_MS = 600_000

/** One pinned PowerShell release. */
interface PwshRuntimeLock {
  readonly schemaVersion: number
  readonly version: string
  readonly archive: string
  readonly origin: string
  readonly mirrors: readonly string[]
  readonly sha256: string
  readonly archiveBytes: number
  readonly files: number
  readonly unpackedBytes: number
}

function readPwshLock(): PwshRuntimeLock {
  const value: unknown = JSON.parse(readFileSync(PWSH_LOCK, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop hub runtime: hub/pwsh-runtime.json must be an object')
  }
  const lock = value as PwshRuntimeLock
  if (typeof lock.version !== 'string' || typeof lock.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(lock.sha256)
    || typeof lock.archive !== 'string' || typeof lock.origin !== 'string'
    || !Array.isArray(lock.mirrors) || lock.mirrors.some(mirror => typeof mirror !== 'string')
    || typeof lock.archiveBytes !== 'number' || typeof lock.files !== 'number' || typeof lock.unpackedBytes !== 'number') {
    throw new Error('desktop hub runtime: hub/pwsh-runtime.json is incomplete')
  }
  return lock
}

/** Verify a cached archive or fail loudly; the build never trusts a download. */
function verifyArchive(bytes: Buffer, lock: PwshRuntimeLock): void {
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== lock.sha256) {
    throw new Error(`desktop hub runtime: ${lock.archive} has SHA-256 ${digest}, expected ${lock.sha256}`)
  }
}

/** Fetch one candidate URL into memory. */
async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' })
  if (!response.ok) throw new Error(`${String(response.status)} ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Return the pinned PowerShell archive from the shared download cache.
 *
 * The cache is keyed by the locked digest, so a copy seeded from a mirror is
 * indistinguishable from the official download and the lock file stays the only
 * authority. Mirrors come first because the release host is slow from mainland
 * networks; every candidate is verified before it is cached.
 */
async function preparePwshArchive(paths: ReturnType<typeof resolveDesktopTargetBuildPaths>, lock: PwshRuntimeLock): Promise<string> {
  const cached = join(paths.downloads, lock.sha256)
  if (existsSync(cached) && statSync(cached).size === lock.archiveBytes) {
    verifyArchive(readFileSync(cached), lock)
    return cached
  }
  mkdirSync(paths.downloads, { recursive: true })
  const candidates = [...lock.mirrors.map(template => template.replace('{archive}', lock.archive)), lock.origin]
  const failures: string[] = []
  for (const url of candidates) {
    try {
      const bytes = await download(url)
      verifyArchive(bytes, lock)
      const temporary = `${cached}.${String(process.pid)}`
      try {
        writeFileSync(temporary, bytes)
        renameSync(temporary, cached)
      } finally {
        rmSync(temporary, { force: true })
      }
      return cached
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`desktop hub runtime: no candidate served ${lock.archive}\n${failures.join('\n')}`)
}

/** Count the files below one directory and their total size. */
function measure(directory: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = measure(path)
      files += nested.files
      bytes += nested.bytes
      continue
    }
    files += 1
    bytes += statSync(path).size
  }
  return { files, bytes }
}

/** Extract the pinned PowerShell archive into `runtime/pwsh/<version>` and describe it. */
async function preparePwsh(paths: ReturnType<typeof resolveDesktopTargetBuildPaths>, lock: PwshRuntimeLock): Promise<void> {
  const archive = await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:pwsh-archive', () => preparePwshArchive(paths, lock))
  const root = join(paths.runtime, 'pwsh')
  const directory = join(root, lock.version)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'extract:pwsh', () => extractZip(archive, { dir: directory }))
  if (!existsSync(join(directory, 'pwsh.exe'))) throw new Error('desktop hub runtime: the PowerShell archive carries no pwsh.exe')
  const measured = measure(directory)
  if (measured.files !== lock.files) {
    throw new Error(`desktop hub runtime: PowerShell extracted ${String(measured.files)} files, expected ${String(lock.files)}`)
  }
  writeFileSync(join(root, 'runtime.json'), `${JSON.stringify({
    schemaVersion: 1,
    version: lock.version,
    directory: lock.version,
    sha256: lock.sha256,
    files: measured.files,
    bytes: measured.bytes,
    source: lock.origin,
  }, undefined, 2)}\n`)
  process.stdout.write(`desktop hub runtime: pwsh ${lock.version} (${String(measured.files)} files, ${String(measured.bytes)} bytes)\n`)
}

/** One directory entry of a written tar archive. */

/** Write one ustar header for a regular file. */
function tarHeader(path: string, size: number, mtime: number): Buffer {
  const header = Buffer.alloc(512, 0)
  if (Buffer.byteLength(path) > 100) throw new Error(`desktop hub runtime: archive path too long: ${path}`)
  header.write(path, 0, 'utf8')
  header.write('0000644\0', 100, 'latin1')
  header.write('0000000\0', 108, 'latin1')
  header.write('0000000\0', 116, 'latin1')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
  header.write(`${mtime.toString(8).padStart(11, '0')}\0`, 136, 'latin1')
  header.write('        ', 148, 'latin1')
  header.write('0', 156, 'latin1')
  header.write('ustar\0', 257, 'latin1')
  header.write('00', 263, 'latin1')
  header.write('0000000\0', 329, 'latin1')
  header.write('0000000\0', 337, 'latin1')
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return header
}

import { pluginFiles } from './hub-plugin-archive.ts'
/**
 * Compile one Hub plugin's TypeScript sources into its `lib/` directory.
 *
 * The plugin is delivered as plain ESM: the profile unpacks the archive without
 * a package manager, so a Host-side build step is the only place type stripping
 * can happen. `--noCheck` keeps the emit a pure transpile — the repository's
 * aggregate Host program owns type checking (`tsconfig.host.json` includes these
 * sources), so a failing build here still means the same errors were reported.
 * @param directory - Plugin package directory holding `tsconfig.build.json`.
 */
function compilePlugin(directory: string): void {
  const configuration = join(directory, 'tsconfig.build.json')
  if (!existsSync(configuration)) return
  rmSync(join(directory, 'lib'), { recursive: true, force: true })
  const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'))
  execFileSync(process.execPath, [tsc, '-p', configuration], { stdio: 'inherit' })
  if (!existsSync(join(directory, 'lib', 'index.js'))) {
    throw new Error(`desktop hub runtime: ${directory} compiled no lib/index.js`)
  }
}

/** Directory one Hub plugin keeps its browser half in, relative to the package. */
const CLIENT_HALF_SOURCE = 'client/index.js'

/** Emitted browser-half path relative to the package, which `exports["./client"]` names. */
const CLIENT_HALF_OUTPUT = 'lib/client.js'

/**
 * Wrap one plugin's browser half in the client module system's factory.
 *
 * The client module system serves `exports["./client"]` verbatim and registers
 * bundles that call `window.__ModuleLoader__.load({ id, factory })`; the shell's
 * tsdown preset emits that wrapper for `packages/client/*`, and a Hub plugin is
 * outside that build, so this step emits the same wrapper here. Two placeholders
 * keep the brand single-sourced: the product name comes from `hub/branding.mjs`
 * and the sidebar mark is the `icon-small` artboard of `hub/brand/source.svg`,
 * inlined as a data URL so the browser needs no extra route or package file.
 * @param directory - Plugin package directory holding `client/index.js`.
 * @returns The emitted bundle path, or undefined when the plugin has no browser half.
 * @throws {Error} When the manifest declares no name or a placeholder stays unresolved.
 */
function buildClientHalf(directory: string): string | undefined {
  const source = join(directory, CLIENT_HALF_SOURCE)
  if (!existsSync(source)) return undefined
  const manifest: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const name = typeof manifest === 'object' && manifest !== null ? (manifest as { name?: unknown }).name : undefined
  if (typeof name !== 'string' || name === '') throw new Error(`desktop hub runtime: ${directory} must declare a package name`)
  const mark = standaloneArtboard(readFileSync(BRAND_SOURCE, 'utf8'), ICON_ARTBOARDS.small)
  const body = resolveClientHalf(readFileSync(source, 'utf8'), { productName: DESKTOP_BRANDING.productName, markUrl: svgDataUrl(mark) })
  const wrapped = wrapClientHalf(name, body)
  const output = join(directory, CLIENT_HALF_OUTPUT)
  mkdirSync(join(directory, 'lib'), { recursive: true })
  writeFileSync(output, wrapped, { mode: 0o644 })
  return output
}

/**
 * Record what the installer baked in, beside the plugin: the Hub origin and the
 * release channel. The connector reads it when no runtime environment variable
 * overrides it.
 * @param directory - Plugin package directory.
 */
function writeBuildInfo(directory: string): void {
  // `branding.mjs` holds the default (empty), and the packaging entry point passes
  // `DSH_HUB_ORIGIN` for a Hub-branded build; an unset origin ships a connector that
  // waits for the account page to name one.
  const origin = (process.env.DSH_HUB_ORIGIN ?? '').trim()
  const channel = (process.env.DSH_HUB_CHANNEL ?? '').trim() === 'nightly' ? 'nightly' : 'latest'
  writeFileSync(join(directory, 'build-info.json'), `${JSON.stringify({ schemaVersion: 1, channel, hubOrigin: origin }, undefined, 2)}\n`, { mode: 0o600 })
}

/**
 * Pack one Hub plugin directory as an npm package archive.
 * @param directory - Package source directory holding its `package.json`.
 * @param destination - Archive path to write.
 * @returns Package name and version the archive declares, plus the entry count.
 */
function packPlugin(directory: string, destination: string): { name: string; version: string; entries: number } {
  const manifest: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null) throw new Error(`desktop hub runtime: ${directory} has no package manifest`)
  const { name, version } = manifest as { name?: unknown; version?: unknown }
  if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') {
    throw new Error(`desktop hub runtime: ${directory} must declare a package name and version`)
  }
  const entries = pluginFiles(directory)
  const mtime = Math.floor(Date.now() / 1000)
  const blocks: Buffer[] = []
  for (const entry of entries) {
    blocks.push(tarHeader(entry.path, entry.contents.byteLength, mtime), entry.contents)
    const padding = (512 - (entry.contents.byteLength % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  const archive = gzipSync(Buffer.concat(blocks), { level: 9 })
  writeFileSync(destination, archive)
  // A packaged archive must read back with the same files the shell will install.
  const read = extractPackageArchive(archive)
  if (read.length !== entries.length) {
    throw new Error(`desktop hub runtime: ${destination} read back ${String(read.length)} of ${String(entries.length)} files`)
  }
  return { name, version, entries: entries.length }
}

/** Pack every bundled Hub plugin and write the manifest the shell activates from. */
function prepareHubPlugins(paths: ReturnType<typeof resolveDesktopTargetBuildPaths>): void {
  const root = join(paths.runtime, 'hub-plugins')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const plugins: { name: string; version: string; file: string }[] = []
  const sources = join(appRoot(), 'hub', 'plugins')
  for (const entry of readdirSync(sources).sort()) {
    const directory = join(sources, entry)
    if (!statSync(directory).isDirectory()) continue
    const manifest: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const { name, version } = manifest as { name?: unknown; version?: unknown }
    if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') {
      throw new Error(`desktop hub runtime: ${directory} must declare a package name and version`)
    }
    // Compile the TypeScript sources and record the build identity before packing:
    // the archive carries `lib/` and `build-info.json`, never the sources.
    compilePlugin(directory)
    buildClientHalf(directory)
    writeBuildInfo(directory)
    // npm archive naming: the scope separator is dropped, so the file name is unique per plugin.
    const file = `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`
    const packed = packPlugin(directory, join(root, file))
    plugins.push({ name: packed.name, version: packed.version, file })
    process.stdout.write(`desktop hub runtime: packed ${packed.name}@${packed.version} (${String(packed.entries)} files)\n`)
  }
  writeFileSync(join(root, 'hub-plugins.json'), `${JSON.stringify({ schemaVersion: 1, plugins }, undefined, 2)}\n`)
}

/** One third-party plugin the installer carries, as `hub/bundled-plugins.json` declares it. */
interface BundledPluginDeclaration {
  /** npm package name. */
  readonly package: string
  /** Exact version the archive's own manifest declares. */
  readonly version: string
  /** Archive file name beside the manifest, inside `hub/bundled-plugins/`. */
  readonly file: string
  /** Lowercase hex SHA-256 of the archive bytes. */
  readonly sha256: string
  /** Delivery level: `core` is always on; `default` and `optional` belong to the user. */
  readonly level: 'core' | 'default' | 'optional'
}

/** npm package name form the connector and the plugin manager both accept. */
const BUNDLED_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

/** Thinking levels pi-ai accepts, in escalation order (see `@deepseek-ai/dsh-llm-pi-ai`). */
const BUNDLED_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Read and validate `hub/bundled-plugins.json`.
 * @param path - Manifest path in the checkout.
 * @returns The declarations, in manifest order.
 * @throws {Error} When the manifest is missing, malformed, or names an unusable archive file.
 */
function readBundledPluginDeclarations(path: string): BundledPluginDeclaration[] {
  if (!existsSync(path)) throw new Error(`desktop hub runtime: ${path} is missing`)
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(value)) throw new Error(`desktop hub runtime: ${path} must hold an array`)
  return value.map((entry: unknown, index: number) => {
    const record = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : undefined
    const name = record?.package
    const version = record?.version
    const file = record?.file
    const sha256 = record?.sha256
    const level = record?.level
    if (typeof name !== 'string' || !BUNDLED_PACKAGE_NAME.test(name) || typeof version !== 'string' || version === ''
      || typeof file !== 'string' || file === '' || file.includes('/') || file.includes('\\') || file.includes('..')
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)
      || (level !== 'core' && level !== 'default' && level !== 'optional')) {
      throw new Error(`desktop hub runtime: ${path} entry ${String(index)} is not a valid bundled plugin declaration`)
    }
    return { package: name, version, file, sha256, level }
  })
}

/**
 * Verify one declared archive against its own package manifest.
 *
 * The digest catches a swapped file; reading the archive's own `package.json`
 * catches a digest the manifest was updated to without repacking, which would
 * install a version the Hub and the user never asked for.
 * @param bytes - Archive bytes.
 * @param plugin - Declaration the archive is supposed to satisfy.
 * @throws {Error} When the archive names another package or version.
 */
function verifyBundledArchive(bytes: Buffer, plugin: BundledPluginDeclaration): void {
  // `extractPackageArchive` paths are relative to the archive's single top-level directory.
  const manifest = extractPackageArchive(bytes).find(entry => entry.path === 'package.json')
  if (manifest === undefined) throw new Error(`desktop hub runtime: ${plugin.file} carries no package.json`)
  const parsed: unknown = JSON.parse(manifest.contents.toString('utf8'))
  const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  if (record.name !== plugin.package || record.version !== plugin.version) {
    throw new Error(`desktop hub runtime: ${plugin.file} declares ${String(record.name)}@${String(record.version)}`
      + `, hub/bundled-plugins.json declares ${plugin.package}@${plugin.version}`)
  }
}

/**
 * Validate the bundled model snapshot.
 *
 * The snapshot carries model ids, display names, the default model, and the
 * thinking levels each model offers — never a key or an endpoint. A connector
 * that cannot read a consistent snapshot would render a route the Host rejects
 * at boot, so every inconsistency fails the build instead.
 * @param path - `hub/bundled-models.json` in the checkout.
 * @returns The parsed snapshot.
 * @throws {Error} When a member is missing, empty, or disagrees with another.
 */
function readBundledModels(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  if (record === undefined) throw new Error(`desktop hub runtime: ${path} must hold an object`)
  const reasoningEfforts = (model: Record<string, unknown>, label: string): void => {
    const efforts = model.reasoningEfforts
    if (efforts === undefined) return
    if (typeof efforts !== 'object' || efforts === null || Array.isArray(efforts) || Object.keys(efforts).length === 0) {
      throw new Error(`desktop hub runtime: ${label} has an unusable reasoningEfforts`)
    }
    const kept: Record<string, string | null> = {}
    for (const [level, wire] of Object.entries(efforts)) {
      // The Hub's own renderer drops levels pi-ai does not offer, and the production
      // export carries one such key (`false`); shipping it would only confuse the
      // picker, so it is dropped here with the rest of the unknown levels.
      if (!BUNDLED_THINKING_LEVELS.includes(level)) {
        process.stdout.write(`desktop hub runtime: ${label} drops unsupported thinking level ${level}\n`)
        continue
      }
      if (wire !== null && (typeof wire !== 'string' || wire === '')) {
        throw new Error(`desktop hub runtime: ${label} has a non-string thinking value for ${level}`)
      }
      kept[level] = wire
    }
    if (!Object.keys(kept).some(level => level !== 'off')) {
      throw new Error(`desktop hub runtime: ${label} offers no thinking level beyond off`)
    }
    model.reasoningEfforts = kept
  }
  const modelEntry = (entry: unknown, ids: Set<string>, label: string): void => {
    const model = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined
    if (model === undefined || typeof model.id !== 'string' || model.id === '' || ids.has(model.id)) {
      throw new Error(`desktop hub runtime: ${label} has a model without a unique id`)
    }
    ids.add(model.id)
    if (typeof model.name !== 'string' || model.name === '') {
      throw new Error(`desktop hub runtime: ${label} model ${model.id} has no name`)
    }
    reasoningEfforts(model, `${label} model ${model.id}`)
  }
  const defaultEffort = (effort: unknown, label: string): void => {
    if (effort === undefined) return
    if (typeof effort !== 'string' || !BUNDLED_THINKING_LEVELS.includes(effort)) {
      throw new Error(`desktop hub runtime: ${label} is not a thinking level`)
    }
  }
  if (record.schemaVersion === 2) {
    // The production export: the Hub's llm-pi-ai fragment minus baseURL/apiKeyEnv, plus agentDefaultModel.
    const llmPiAi = typeof record.llmPiAi === 'object' && record.llmPiAi !== null && !Array.isArray(record.llmPiAi)
      ? record.llmPiAi as Record<string, unknown>
      : undefined
    const providers = typeof llmPiAi?.providers === 'object' && llmPiAi.providers !== null && !Array.isArray(llmPiAi.providers)
      ? llmPiAi.providers as Record<string, unknown>
      : undefined
    if (providers === undefined || Object.keys(providers).length === 0) {
      throw new Error(`desktop hub runtime: ${path} must list at least one provider`)
    }
    const routes = new Map<string, Set<string>>()
    for (const [route, providerValue] of Object.entries(providers)) {
      const provider = typeof providerValue === 'object' && providerValue !== null && !Array.isArray(providerValue)
        ? providerValue as Record<string, unknown>
        : undefined
      if (provider === undefined || !Array.isArray(provider.models) || provider.models.length === 0) {
        throw new Error(`desktop hub runtime: ${path} provider ${route} must list at least one model`)
      }
      const ids = new Set<string>()
      for (const entry of provider.models) modelEntry(entry, ids, `${path} provider ${route}`)
      routes.set(route, ids)
    }
    const selection = typeof record.agentDefaultModel === 'object' && record.agentDefaultModel !== null
      && !Array.isArray(record.agentDefaultModel)
      ? record.agentDefaultModel as Record<string, unknown>
      : undefined
    if (selection !== undefined) {
      const provider = selection.provider
      const model = selection.model
      if (typeof provider !== 'string' || typeof model !== 'string') {
        throw new Error(`desktop hub runtime: ${path} agentDefaultModel must name a provider and a model`)
      }
      if (!routes.get(provider)?.has(model)) {
        throw new Error(`desktop hub runtime: ${path} agentDefaultModel names ${provider}/${model}, which the snapshot does not offer`)
      }
      defaultEffort(selection.reasoningEffort, `${path} agentDefaultModel.reasoningEffort`)
    }
    return record
  }
  if (record.schemaVersion !== 1) throw new Error(`desktop hub runtime: ${path} must declare schemaVersion 1 or 2`)
  const models = record.models
  if (!Array.isArray(models) || models.length === 0) throw new Error(`desktop hub runtime: ${path} must list at least one model`)
  const ids = new Set<string>()
  for (const entry of models as unknown[]) {
    const model = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined
    if (model === undefined || typeof model.id !== 'string' || model.id === '' || ids.has(model.id)) {
      throw new Error(`desktop hub runtime: ${path} has a model without a unique id`)
    }
    ids.add(model.id)
    if (typeof model.displayName !== 'string' || model.displayName === '') {
      throw new Error(`desktop hub runtime: ${path} model ${model.id} has no displayName`)
    }
    if (model.reasoningEfforts !== undefined) {
      const efforts = model.reasoningEfforts
      if (!Array.isArray(efforts) || efforts.length === 0
        || efforts.some(level => typeof level !== 'string' || !BUNDLED_THINKING_LEVELS.includes(level))) {
        throw new Error(`desktop hub runtime: ${path} model ${model.id} lists an unsupported thinking level`)
      }
    }
  }
  const defaultModel = record.defaultModel
  if (typeof defaultModel !== 'string' || !ids.has(defaultModel)) {
    throw new Error(`desktop hub runtime: ${path} defaultModel must name a listed model`)
  }
  defaultEffort(record.defaultReasoningEffort, `${path} defaultReasoningEffort`)
  return record
}

/**
 * Copy the installer's bundled third-party plugins and the model snapshot into
 * `resources/runtime/hub-plugins/`.
 *
 * The archives are source-controlled beside the manifest so a rebuild needs no
 * outside directory. Every digest, package name, and version is verified here:
 * a mismatch fails the build rather than shipping an archive the connector will
 * refuse after the fact.
 * @param paths - Target build paths; `runtime/hub-plugins` already holds the packaged core plugins.
 */
function prepareBundledPlugins(paths: ReturnType<typeof resolveDesktopTargetBuildPaths>): void {
  const root = join(paths.runtime, 'hub-plugins')
  const declarations = readBundledPluginDeclarations(join(appRoot(), 'hub', 'bundled-plugins.json'))
  for (const plugin of declarations) {
    const source = join(appRoot(), 'hub', 'bundled-plugins', plugin.file)
    if (!existsSync(source)) throw new Error(`desktop hub runtime: ${plugin.file} is missing from hub/bundled-plugins/`)
    const bytes = readFileSync(source)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== plugin.sha256) {
      throw new Error(`desktop hub runtime: ${plugin.file} has SHA-256 ${digest}, hub/bundled-plugins.json declares ${plugin.sha256}`)
    }
    verifyBundledArchive(bytes, plugin)
    writeFileSync(join(root, plugin.file), bytes, { mode: 0o644 })
    process.stdout.write(`desktop hub runtime: bundled ${plugin.package}@${plugin.version} (${plugin.level}, ${String(bytes.byteLength)} bytes)\n`)
  }
  writeFileSync(join(root, 'bundled-plugins.json'), `${JSON.stringify(declarations, undefined, 2)}\n`)
  const models = readBundledModels(join(appRoot(), 'hub', 'bundled-models.json'))
  writeFileSync(join(root, 'bundled-models.json'), `${JSON.stringify(models, undefined, 2)}\n`)
  const summary = models.schemaVersion === 2
    ? `${String(Object.keys((models.llmPiAi as { providers?: Record<string, unknown> }).providers ?? {}).length)} provider route(s)`
    : `${String(Array.isArray(models.models) ? models.models.length : 0)} model(s)`
  process.stdout.write(`desktop hub runtime: bundled model snapshot ${summary}\n`)
}

async function main(): Promise<void> {
  const target = resolveDesktopBuildTarget()
  const paths = resolveDesktopTargetBuildPaths()
  const { platform } = desktopTargetPlatform(target)
  if (platform === 'win32') await preparePwsh(paths, readPwshLock())
  prepareHubPlugins(paths)
  prepareBundledPlugins(paths)
}

await main()
