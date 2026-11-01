/**
 * Seed the Desktop primary-runtime download cache from domestic mirrors.
 *
 * The upstream preparation fetches Node.js from nodejs.org, Python from the
 * astral-sh GitHub release, and Office wheels from files.pythonhosted.org; all
 * three are slow or unreachable from mainland networks. `downloadPrimaryRuntimeAsset`
 * keys its cache by the locked SHA-256, so verified copies fetched from a mirror
 * are indistinguishable from upstream downloads and no lock file changes.
 *
 *   DSH_HUB_CN_MIRRORS=1 DSH_DESKTOP_TARGET_PLATFORM=win32 DSH_DESKTOP_TARGET_ARCH=x64 \
 *     node apps/desktop/hub/seed-runtime-cache.mjs [--cache <dir>]
 *
 * Without `DSH_HUB_CN_MIRRORS=1` this script only fetches the URL the lock file
 * names, which the packaging step would otherwise download itself.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const LOCK_PATH = join(REPOSITORY_ROOT, 'scripts', 'primary-runtime', 'lock.json')

/**
 * Mainland mirrors that serve the same path layout as the upstream origin.
 * `DSH_HUB_CN_MIRRORS=1` selects them; without it every candidate keeps the URL the
 * lock file names, so a build downloads from the origins upstream uses.
 */
const MIRRORS = process.env.DSH_HUB_CN_MIRRORS === '1' ? [
  { origin: 'https://nodejs.org/dist/', mirror: 'https://npmmirror.com/mirrors/node/' },
  {
    origin: 'https://github.com/astral-sh/python-build-standalone/releases/download/',
    mirror: 'https://registry.npmmirror.com/-/binary/python-build-standalone/',
  },
  { origin: 'https://files.pythonhosted.org/', mirror: 'https://pypi.tuna.tsinghua.edu.cn/' },
] : []

function targetName(platform, arch) {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' || platform === 'win' ? 'win' : platform
  return `${os}-${arch}`
}

function mirrorUrl(url) {
  for (const { origin, mirror } of MIRRORS) {
    if (url.startsWith(origin)) return `${mirror}${url.slice(origin.length)}`
  }
  return url
}

/**
 * Fetch one locked archive into the shared cache unless a verified copy exists.
 * @param {string | readonly string[]} sources - Upstream URL recorded in the lock file, or an ordered candidate list.
 * @param {string} sha256 - Locked digest the cache is keyed by.
 * @param {string} cache - Shared Desktop download cache.
 * @returns {Promise<'cached' | 'downloaded'>} What this call had to do.
 */
async function seed(sources, sha256, cache) {
  const destination = join(cache, sha256)
  if (existsSync(destination) && statSync(destination).size > 0) return 'cached'
  let bytes
  const failures = []
  for (const candidate of Array.isArray(sources) ? sources : [sources]) {
    const source = mirrorUrl(candidate)
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(600_000), redirect: 'follow' })
      if (!response.ok) throw new Error(`${String(response.status)} ${source}`)
      const downloaded = Buffer.from(await response.arrayBuffer())
      const digest = createHash('sha256').update(downloaded).digest('hex')
      if (digest !== sha256) throw new Error(`checksum mismatch for ${source}`)
      bytes = downloaded
      break
    } catch (error) {
      failures.push(`${source}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (bytes === undefined) throw new Error(`seed-runtime-cache: no candidate served ${sha256}\n${failures.join('\n')}`)
  mkdirSync(cache, { recursive: true })
  const temporary = `${destination}.${process.pid}`
  try {
    writeFileSync(temporary, bytes)
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
  return 'downloaded'
}

const cacheArgument = process.argv.indexOf('--cache')
const cache = cacheArgument === -1
  ? join(APP_ROOT, '.desktop-build', 'downloads')
  : resolve(process.argv[cacheArgument + 1] ?? '')
const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
const target = targetName(process.env.DSH_DESKTOP_TARGET_PLATFORM ?? process.platform,
  process.env.DSH_DESKTOP_TARGET_ARCH ?? process.arch)
const artifact = lock.targets[target]
if (artifact === undefined) throw new Error(`seed-runtime-cache: lock file has no ${target} target`)

const nodeFile = `node-v${lock.nodeVersion}-${artifact.nodeArchive}`
const pythonFile = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${artifact.pythonTarget}-install_only_stripped.tar.gz`
const urls = [
  [`https://nodejs.org/dist/v${lock.nodeVersion}/${nodeFile}`, artifact.nodeSha256],
  [`https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(pythonFile)}`, artifact.pythonSha256],
  ...artifact.wheels.map(wheel => [wheel.url, wheel.sha256]),
]
// The bundled PowerShell release is keyed the same way: the packaging step reuses this
// cache, and a mirror copy that matches the pinned digest is the official archive.
if (target.startsWith('win')) {
  const pwsh = JSON.parse(readFileSync(join(APP_ROOT, 'hub', 'pwsh-runtime.json'), 'utf8'))
  const mirrors = MIRRORS.length === 0
    ? []
    : pwsh.mirrors.map(template => template.replace('{archive}', pwsh.archive))
  urls.push([[...mirrors, pwsh.origin], pwsh.sha256])
}

const results = []
for (const [url, sha256] of urls) results.push(await seed(url, sha256, cache))
console.info(`seed-runtime-cache: ${target} into ${cache}: ${results.filter(result => result === 'downloaded').length} downloaded, ${results.filter(result => result === 'cached').length} already cached`)
