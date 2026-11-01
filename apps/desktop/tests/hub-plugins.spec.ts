import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activateBundledHubPlugins, activateBundledThirdPartyPlugins, installedHubPlugins,
  readBundledHubPlugins, readBundledThirdPartyPlugins, seedHubOverlay,
} from '../src/hub-plugins.ts'
import { HUB_OVERLAY_FILENAME } from '../src/hub-overlay.ts'

const roots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hub-plugins-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Lay out a packaged hub-plugins directory with the connector fixture archive. */
function packagedPlugins(options: { version?: string } = {}): string {
  const directory = join(temporaryRoot(), 'hub-plugins')
  mkdirSync(directory, { recursive: true })
  const file = 'dsh-hub-hub-connector-0.0.1.tgz'
  copyFileSync(join(import.meta.dirname, 'fixtures', 'hub-connector-0.0.1.tgz'), join(directory, file))
  writeFileSync(join(directory, 'hub-plugins.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: [{ name: '@dsh-hub/hub-connector', version: options.version ?? '0.0.1', file }],
  }))
  return directory
}

/** Create the desktop profile an initialized install has. */
function profile(): string {
  const directory = join(temporaryRoot(), 'profile')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-desktop-runtime',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, undefined, 2))
  return directory
}

describe('bundled plugin manifest', () => {
  it('reads the packages the build declares', () => {
    expect(readBundledHubPlugins(packagedPlugins())).toEqual([
      { name: '@dsh-hub/hub-connector', version: '0.0.1', file: 'dsh-hub-hub-connector-0.0.1.tgz' },
    ])
  })

  it('reports no plugins when the build ships none', () => {
    expect(readBundledHubPlugins(join(temporaryRoot(), 'absent'))).toEqual([])
  })

  it('rejects a manifest entry that is not a package name', () => {
    const directory = join(temporaryRoot(), 'hub-plugins')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'hub-plugins.json'), JSON.stringify({
      schemaVersion: 1, plugins: [{ name: '../escape', version: '1.0.0', file: 'x.tgz' }],
    }))
    expect(() => readBundledHubPlugins(directory)).toThrow(/invalid plugin entry/u)
  })
})

describe('activation', () => {
  it('installs the package, records the dependency, and enables the bundle', () => {
    const directory = profile()
    const activations = activateBundledHubPlugins({ source: packagedPlugins(), profile: directory })
    expect(activations).toEqual([{ name: '@dsh-hub/hub-connector', version: '0.0.1', state: 'installed' }])
    expect(existsSync(join(directory, 'node_modules', '@dsh-hub', 'hub-connector', 'index.js'))).toBe(true)
    expect(existsSync(join(directory, 'node_modules', '@dsh-hub', 'hub-connector', 'cordis.patch.yml'))).toBe(true)
    expect(existsSync(join(directory, 'hub-plugins', 'dsh-hub-hub-connector-0.0.1.tgz'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies['@dsh-hub/hub-connector']).toBe('file:./hub-plugins/dsh-hub-hub-connector-0.0.1.tgz')
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-hub/hub-connector',
    ])
    expect(installedHubPlugins(directory)).toEqual(['@dsh-hub/hub-connector'])
  })

  it('leaves an installed version in place on the next start', () => {
    const directory = profile()
    const source = packagedPlugins()
    activateBundledHubPlugins({ source, profile: directory })
    const again = activateBundledHubPlugins({ source, profile: directory })
    expect(again).toEqual([{ name: '@dsh-hub/hub-connector', version: '0.0.1', state: 'current' }])
    expect((JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }).dsh.profile.bundles.filter(name => name === '@dsh-hub/hub-connector')).toHaveLength(1)
  })

  it('replaces an installed package whose version the build no longer ships', () => {
    const directory = profile()
    const source = packagedPlugins()
    activateBundledHubPlugins({ source, profile: directory })
    // A package the build now carries at a different version is replaced, including its files.
    const installed = join(directory, 'node_modules', '@dsh-hub', 'hub-connector')
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: '@dsh-hub/hub-connector', version: '0.0.0' }))
    writeFileSync(join(installed, 'stale.txt'), 'old\n')
    const replaced = activateBundledHubPlugins({ source, profile: directory })
    expect(replaced[0]?.state).toBe('installed')
    expect(existsSync(join(installed, 'stale.txt'))).toBe(false)
  })
})

describe('Hub overlay', () => {
  it('seeds the overlay once with the connector row', () => {
    const directory = profile()
    const path = seedHubOverlay(directory, { connectorInstalled: true, hubOrigin: 'https://hub.example' })
    expect(path).toBe(join(directory, HUB_OVERLAY_FILENAME))
    const contents = readFileSync(join(directory, HUB_OVERLAY_FILENAME), 'utf8')
    expect(contents).toContain('- id: hub-connector')
    expect(contents).toContain('configSource: overlay')
    expect(contents).toContain('https://hub.example')
    writeFileSync(join(directory, HUB_OVERLAY_FILENAME), '# replaced by the connector\n')
    seedHubOverlay(directory, { connectorInstalled: true, hubOrigin: '' })
    expect(readFileSync(join(directory, HUB_OVERLAY_FILENAME), 'utf8')).toBe('# replaced by the connector\n')
  })

  it('omits the connector row when no bundled plugin is installed', () => {
    const directory = profile()
    seedHubOverlay(directory, { connectorInstalled: false, hubOrigin: '' })
    expect(readFileSync(join(directory, HUB_OVERLAY_FILENAME), 'utf8')).not.toContain('- id:')
  })
})


/** A real archive the installer carries, used as the third-party fixture. */
const FIXTURE_ARCHIVE = join(import.meta.dirname, '../hub/bundled-plugins/xdedmi-dsh-session-id-1.0.0.tgz')
const FIXTURE_PACKAGE = '@xdedmi/dsh-session-id'
const FIXTURE_VERSION = '1.0.0'
const FIXTURE_FILE = 'xdedmi-dsh-session-id-1.0.0.tgz'
const FIXTURE_SHA256 = createHash('sha256').update(readFileSync(FIXTURE_ARCHIVE)).digest('hex')

/** Lay out a packaged directory with third-party declarations beside the real archive. */
function packagedThirdParty(
  declarations: readonly { package: string; version: string; level?: string }[],
  options: { readonly tamperSha?: boolean } = {},
): string {
  const directory = join(temporaryRoot(), 'hub-plugins')
  mkdirSync(directory, { recursive: true })
  copyFileSync(FIXTURE_ARCHIVE, join(directory, FIXTURE_FILE))
  writeFileSync(join(directory, 'bundled-plugins.json'), JSON.stringify(declarations.map(entry => ({
    file: FIXTURE_FILE,
    sha256: options.tamperSha === true ? 'f'.repeat(64) : FIXTURE_SHA256,
    level: 'default',
    ...entry,
  }))))
  return directory
}

/** Rewrite the profile's bundle list, as a user's disable (or an enable) would. */
function setBundles(profileDirectory: string, bundles: readonly string[]): void {
  const manifest = JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8')) as {
    dsh: { profile: { bundles: string[] } }
  }
  manifest.dsh.profile.bundles = [...bundles]
  writeFileSync(join(profileDirectory, 'package.json'), JSON.stringify(manifest, undefined, 2))
}

/** The profile's bundle list and dependencies. */
function profileState(profileDirectory: string): { bundles: string[]; dependencies: Record<string, string> } {
  const manifest = JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  return { bundles: manifest.dsh.profile.bundles, dependencies: manifest.dependencies }
}

describe('third-party bundled plugins (design §4.2, round 2)', () => {
  it('reads the declarations and rejects a file name that could escape the directory', () => {
    const directory = packagedThirdParty([{ package: FIXTURE_PACKAGE, version: FIXTURE_VERSION }])
    expect(readBundledThirdPartyPlugins(directory)).toEqual([{
      name: FIXTURE_PACKAGE, version: FIXTURE_VERSION, file: FIXTURE_FILE,
      sha256: FIXTURE_SHA256, level: 'default',
    }])
    writeFileSync(join(directory, 'bundled-plugins.json'), JSON.stringify([{
      package: FIXTURE_PACKAGE, version: FIXTURE_VERSION, file: '../x.tgz', sha256: FIXTURE_SHA256, level: 'default',
    }]))
    expect(() => readBundledThirdPartyPlugins(directory)).toThrow(/invalid third-party plugin entry/u)
  })

  it('installs before the Host starts, records the dependency, and enables the bundle', () => {
    const directory = profile()
    const activations = activateBundledThirdPartyPlugins({
      source: packagedThirdParty([{ package: FIXTURE_PACKAGE, version: FIXTURE_VERSION }]),
      profile: directory,
    })
    expect(activations).toEqual([{ name: FIXTURE_PACKAGE, version: FIXTURE_VERSION, state: 'installed' }])
    expect(existsSync(join(directory, 'node_modules', '@xdedmi', 'dsh-session-id', 'package.json'))).toBe(true)
    expect(existsSync(join(directory, 'node_modules', '@xdedmi', 'dsh-session-id', 'index.js'))).toBe(true)
    const state = profileState(directory)
    expect(state.dependencies[FIXTURE_PACKAGE]).toBe(`file:./hub-plugins/${FIXTURE_FILE}`)
    expect(state.bundles).toContain(FIXTURE_PACKAGE)
    expect(installedHubPlugins(directory)).toContain(FIXTURE_PACKAGE)
  })

  it('does nothing on the next start and never duplicates the bundle entry', () => {
    const directory = profile()
    const source = packagedThirdParty([{ package: FIXTURE_PACKAGE, version: FIXTURE_VERSION }])
    activateBundledThirdPartyPlugins({ source, profile: directory })
    const again = activateBundledThirdPartyPlugins({ source, profile: directory })
    expect(again).toEqual([{ name: FIXTURE_PACKAGE, version: FIXTURE_VERSION, state: 'current' }])
    expect(profileState(directory).bundles.filter(name => name === FIXTURE_PACKAGE)).toHaveLength(1)
  })

  it('keeps a version newer than the installer ships, so the Hub upgrade is not undone', () => {
    const directory = profile()
    const target = join(directory, 'node_modules', '@xdedmi', 'dsh-session-id')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: FIXTURE_PACKAGE, version: '9.9.9' }))
    const activations = activateBundledThirdPartyPlugins({
      source: packagedThirdParty([{ package: FIXTURE_PACKAGE, version: FIXTURE_VERSION }]),
      profile: directory,
    })
    expect(activations).toEqual([{ name: FIXTURE_PACKAGE, version: '9.9.9', state: 'kept-newer' }])
    expect(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))).toMatchObject({ version: '9.9.9' })
  })

  it('leaves a non-core plugin the user disabled out of the bundle list', () => {
    const directory = profile()
    const source = packagedThirdParty([{ package: FIXTURE_PACKAGE, version: FIXTURE_VERSION }])
    activateBundledThirdPartyPlugins({ source, profile: directory })
    setBundles(directory, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    activateBundledThirdPartyPlugins({ source, profile: directory })
    expect(profileState(directory).bundles).not.toContain(FIXTURE_PACKAGE)
  })

  it('puts a core plugin back in the bundle list', () => {
    const directory = profile()
    const source = packagedThirdParty([{ package: FIXTURE_PACKAGE, version: FIXTURE_VERSION, level: 'core' }])
    activateBundledThirdPartyPlugins({ source, profile: directory })
    setBundles(directory, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const activations = activateBundledThirdPartyPlugins({ source, profile: directory })
    expect(activations[0]?.state).toBe('current')
    expect(profileState(directory).bundles).toContain(FIXTURE_PACKAGE)
  })

  it('does not restore a package a Hub manifest explicitly uninstalled', () => {
    const directory = profile()
    mkdirSync(join(directory, 'desktop-hub'), { recursive: true })
    writeFileSync(join(directory, 'desktop-hub', 'state.json'), JSON.stringify({
      schemaVersion: 1, bundledRemovals: [FIXTURE_PACKAGE],
    }))
    const activations = activateBundledThirdPartyPlugins({
      source: packagedThirdParty([{ package: FIXTURE_PACKAGE, version: FIXTURE_VERSION }]),
      profile: directory,
    })
    expect(activations).toEqual([{ name: FIXTURE_PACKAGE, version: FIXTURE_VERSION, state: 'skipped-removed' }])
    expect(existsSync(join(directory, 'node_modules', '@xdedmi', 'dsh-session-id'))).toBe(false)
  })

  it('refuses an archive whose digest differs from the declaration', () => {
    const directory = profile()
    expect(() => activateBundledThirdPartyPlugins({
      source: packagedThirdParty([{ package: FIXTURE_PACKAGE, version: FIXTURE_VERSION }], { tamperSha: true }),
      profile: directory,
    })).toThrow(/SHA-256/u)
  })
})
