/**
 * The installer's bundled plugins (design §4.2).
 *
 * What matters here is the precedence: the baseline installs without an account,
 * a higher installed version is never downgraded, a Hub manifest outranks the
 * baseline, and a package the Hub explicitly uninstalled stays uninstalled.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  BUNDLED_PLUGIN_MANIFEST,
  activateBundledPlugins,
  mergeBundledRecords,
  missingBundleDependencies,
  readBundledPluginManifest,
  resolveBundledDependencies,
  type BundledPluginDeclaration,
} from '../../hub/plugins/hub-connector/src/bundled.ts'
import type { ChangeOutcome, InstalledBundle } from '../../hub/plugins/hub-connector/src/manifest.ts'
import type { ManagedPluginRecord } from '../../hub/plugins/hub-connector/src/state.ts'

/** One temporary directory. */
function temporary(): string {
  return mkdtempSync(join(tmpdir(), 'hub-bundled-'))
}

/** Write one archive and its declaration, returning both. */
function bundled(directory: string, name: string, version: string, level: BundledPluginDeclaration['level'] = 'default'): BundledPluginDeclaration {
  const file = `${name.replaceAll('/', '-').replace('@', '')}-${version}.tgz`
  const bytes = Buffer.from(`archive:${name}@${version}`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, file), bytes)
  return { package: name, version, file, sha256: createHash('sha256').update(bytes).digest('hex'), level }
}

/** Write the manifest beside the archives. */
function writeManifest(directory: string, declarations: readonly BundledPluginDeclaration[]): void {
  writeFileSync(join(directory, BUNDLED_PLUGIN_MANIFEST), `${JSON.stringify(declarations, undefined, 2)}\n`)
}

/** A host with a fake plugin manager, recording every call. */
function harness(options: {
  readonly installed?: readonly InstalledBundle[]
  readonly installError?: string
  readonly setEnabledError?: string
} = {}) {
  const profile = temporary()
  const bundles: InstalledBundle[] = [...options.installed ?? []]
  const calls: string[] = []
  const install = vi.fn(async (spec: string): Promise<ChangeOutcome> => {
    calls.push(`install:${spec}`)
    if (options.installError !== undefined) return { changed: false, error: options.installError }
    return { changed: true }
  })
  const setEnabled = vi.fn(async (name: string, enabled: boolean): Promise<ChangeOutcome> => {
    calls.push(`toggle:${name}:${String(enabled)}`)
    return options.setEnabledError === undefined ? { changed: true } : { changed: false, error: options.setEnabledError }
  })
  return {
    profile,
    bundles,
    calls,
    install,
    setEnabled,
    deps: {
      directory: join(profile, 'installer'),
      profile,
      listBundles: async () => bundles,
      install,
      setEnabled,
      suppressed: [] as readonly string[],
    },
  }
}

describe('bundled plugin manifest', () => {
  it('reads declarations in manifest order and tolerates a build without the file', () => {
    const directory = temporary()
    expect(readBundledPluginManifest(directory)).toEqual([])
    const declarations = [
      bundled(directory, '@local/dsh-memory', '0.1.3'),
      bundled(directory, 'dsh-better-sidebar', '0.28.0', 'core'),
    ]
    writeManifest(directory, declarations)
    expect(readBundledPluginManifest(directory)).toEqual(declarations)
  })

  it('rejects a declaration that could escape the archive directory', () => {
    const directory = temporary()
    writeFileSync(join(directory, BUNDLED_PLUGIN_MANIFEST), JSON.stringify([{
      package: '@local/dsh-memory', version: '0.1.3', file: '../outside.tgz', sha256: 'a'.repeat(64), level: 'default',
    }]))
    expect(() => readBundledPluginManifest(directory)).toThrow(/valid declaration/u)
  })
})

describe('bundled plugin activation', () => {
  it('installs an absent package from a staged profile archive and records source bundled', async () => {
    const host = harness()
    const declaration = bundled(host.deps.directory, '@local/dsh-memory', '0.1.3')
    writeManifest(host.deps.directory, [declaration])
    const outcome = await activateBundledPlugins(host.deps)
    expect(outcome.failures).toBe(0)
    expect(outcome.records).toEqual([{ name: '@local/dsh-memory', version: '0.1.3', source: 'bundled', enabled: true }])
    const staged = join(host.profile, 'desktop-hub', 'bundled', declaration.file)
    expect(existsSync(staged)).toBe(true)
    expect(host.install).toHaveBeenCalledWith(`file:${staged}`, { saveExact: true })
  })

  it('leaves a package at the declared version alone and keeps its disabled flag', async () => {
    const host = harness({ installed: [{ name: '@local/dsh-memory', version: '0.1.3', enabled: false }] })
    writeManifest(host.deps.directory, [bundled(host.deps.directory, '@local/dsh-memory', '0.1.3')])
    const outcome = await activateBundledPlugins(host.deps)
    expect(host.install).not.toHaveBeenCalled()
    expect(outcome.records).toEqual([{ name: '@local/dsh-memory', version: '0.1.3', source: 'bundled', enabled: false }])
  })

  it('installs when the installer ships a higher version than the profile has', async () => {
    const host = harness({ installed: [{ name: '@local/dsh-memory', version: '0.1.2', enabled: true }] })
    writeManifest(host.deps.directory, [bundled(host.deps.directory, '@local/dsh-memory', '0.1.3')])
    const outcome = await activateBundledPlugins(host.deps)
    expect(host.calls).toHaveLength(1)
    expect(outcome.records[0]).toMatchObject({ version: '0.1.3', source: 'bundled' })
  })

  it('never downgrades a package the profile already has at a higher version', async () => {
    const host = harness({ installed: [{ name: '@local/dsh-memory', version: '0.2.0', enabled: true }] })
    writeManifest(host.deps.directory, [bundled(host.deps.directory, '@local/dsh-memory', '0.1.3')])
    const outcome = await activateBundledPlugins(host.deps)
    expect(host.install).not.toHaveBeenCalled()
    expect(outcome.records).toEqual([{ name: '@local/dsh-memory', version: '0.2.0', source: 'bundled', enabled: true }])
  })

  it('forces a core package on and lets the user disable a default package', async () => {
    const host = harness({
      installed: [
        { name: 'dsh-better-sidebar', version: '0.28.0', enabled: false },
        { name: '@local/dsh-memory', version: '0.1.3', enabled: false },
      ],
    })
    writeManifest(host.deps.directory, [
      bundled(host.deps.directory, 'dsh-better-sidebar', '0.28.0', 'core'),
      bundled(host.deps.directory, '@local/dsh-memory', '0.1.3'),
    ])
    const outcome = await activateBundledPlugins(host.deps)
    expect(host.calls).toEqual(['toggle:dsh-better-sidebar:true'])
    expect(outcome.records).toEqual([
      { name: 'dsh-better-sidebar', version: '0.28.0', source: 'bundled', enabled: true },
      { name: '@local/dsh-memory', version: '0.1.3', source: 'bundled', enabled: false },
    ])
  })

  it('skips a package a Hub manifest uninstalled, so the baseline does not undo the Hub', async () => {
    const host = harness()
    writeManifest(host.deps.directory, [bundled(host.deps.directory, '@local/dsh-memory', '0.1.3')])
    const outcome = await activateBundledPlugins({ ...host.deps, suppressed: ['@local/dsh-memory'] })
    expect(host.install).not.toHaveBeenCalled()
    expect(outcome.records).toEqual([])
    expect(outcome.declared).toEqual(['@local/dsh-memory'])
  })

  it('refuses an archive whose digest does not match the declaration', async () => {
    const host = harness()
    const declaration = bundled(host.deps.directory, '@local/dsh-memory', '0.1.3')
    writeFileSync(join(host.deps.directory, declaration.file), Buffer.from('tampered'))
    writeManifest(host.deps.directory, [declaration])
    const outcome = await activateBundledPlugins(host.deps)
    expect(host.install).not.toHaveBeenCalled()
    expect(outcome.failures).toBe(1)
    expect(outcome.records).toEqual([])
  })

  it('accepts an install another instance finished while this one waited', async () => {
    const host = harness({ installed: [], installError: 'already-installed' })
    const declaration = bundled(host.deps.directory, '@local/dsh-memory', '0.1.3')
    writeManifest(host.deps.directory, [declaration])
    // The manager reports the package as installed on the verification read.
    host.deps.listBundles = async () => [{ name: '@local/dsh-memory', version: '0.1.3', enabled: true }]
    const outcome = await activateBundledPlugins(host.deps)
    expect(outcome.failures).toBe(0)
    expect(outcome.records).toEqual([{ name: '@local/dsh-memory', version: '0.1.3', source: 'bundled', enabled: true }])
  })
})

describe('bundled records in the managed list', () => {
  it('replaces the declared packages and keeps records the manifest no longer declares', () => {
    const previous: ManagedPluginRecord[] = [
      { name: '@local/dsh-memory', version: '0.1.2', source: 'bundled', enabled: true },
      { name: '@local/dsh-old', version: '9.9.9', source: 'bundled', enabled: true },
      { name: '@local/dsh-hub-delivered', version: '1.0.0', source: 'hub-default', enabled: true },
    ]
    const records: ManagedPluginRecord[] = [{ name: '@local/dsh-memory', version: '0.1.3', source: 'bundled', enabled: true }]
    expect(mergeBundledRecords(previous, records, new Set(['@local/dsh-memory']))).toEqual([
      { name: '@local/dsh-old', version: '9.9.9', source: 'bundled', enabled: true },
      { name: '@local/dsh-hub-delivered', version: '1.0.0', source: 'hub-default', enabled: true },
      { name: '@local/dsh-memory', version: '0.1.3', source: 'bundled', enabled: true },
    ])
  })

  it('reads the staged archive back unchanged', async () => {
    const host = harness()
    const declaration = bundled(host.deps.directory, '@local/dsh-memory', '0.1.3')
    writeManifest(host.deps.directory, [declaration])
    await activateBundledPlugins(host.deps)
    const staged = readFileSync(join(host.profile, 'desktop-hub', 'bundled', declaration.file))
    expect(createHash('sha256').update(staged).digest('hex')).toBe(declaration.sha256)
  })
})

describe('background dependency resolution (round 3)', () => {
  /** Write one installed bundled package that declares a dependency. */
  function installedPilot(profile: string, dependency: string | undefined): void {
    const directory = join(profile, 'node_modules', '@local', 'dsh-claude-pilot')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name: '@local/dsh-claude-pilot',
      version: '0.6.0',
      ...dependency === undefined ? {} : { dependencies: { [dependency]: '1.0.0' } },
    }))
  }

  const bundledRecord: ManagedPluginRecord = {
    name: '@local/dsh-claude-pilot', version: '0.6.0', source: 'bundled', enabled: true,
  }

  it('reports the dependency a bundled package declares but the profile lacks', () => {
    const profile = temporary()
    installedPilot(profile, '@anthropic-ai/claude-agent-sdk')
    expect(missingBundleDependencies(profile, [bundledRecord])).toEqual({
      packages: ['@local/dsh-claude-pilot'],
      dependencies: ['@anthropic-ai/claude-agent-sdk'],
    })
    // Once the dependency directory exists the profile is complete again.
    mkdirSync(join(profile, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), { recursive: true })
    expect(missingBundleDependencies(profile, [bundledRecord])).toEqual({ packages: [], dependencies: [] })
  })

  it('ignores a package the Hub delivered, even when its dependencies are missing', () => {
    const profile = temporary()
    installedPilot(profile, '@anthropic-ai/claude-agent-sdk')
    expect(missingBundleDependencies(profile, [{ ...bundledRecord, source: 'hub-default' }]))
      .toEqual({ packages: [], dependencies: [] })
  })

  it('runs one install and one reload when dependencies are missing', async () => {
    const profile = temporary()
    installedPilot(profile, '@anthropic-ai/claude-agent-sdk')
    const install = vi.fn(async () => true)
    const reload = vi.fn(async () => {})
    const outcome = await resolveBundledDependencies({ profile, records: [bundledRecord], install, reload })
    expect(install).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({
      missing: { packages: ['@local/dsh-claude-pilot'], dependencies: ['@anthropic-ai/claude-agent-sdk'] },
      installed: true,
      reloaded: true,
    })
  })

  it('does nothing when the profile already has every dependency', async () => {
    const profile = temporary()
    installedPilot(profile, undefined)
    const install = vi.fn(async () => true)
    const reload = vi.fn(async () => {})
    const outcome = await resolveBundledDependencies({ profile, records: [bundledRecord], install, reload })
    expect(install).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(outcome).toEqual({ missing: { packages: [], dependencies: [] }, installed: false, reloaded: false })
  })

  it('does not reload when the install fails, so the next start retries', async () => {
    const profile = temporary()
    installedPilot(profile, '@anthropic-ai/claude-agent-sdk')
    const install = vi.fn(async () => false)
    const reload = vi.fn(async () => {})
    const outcome = await resolveBundledDependencies({ profile, records: [bundledRecord], install, reload })
    expect(reload).not.toHaveBeenCalled()
    expect(outcome.installed).toBe(false)
    expect(outcome.missing.packages).toEqual(['@local/dsh-claude-pilot'])
  })
})
