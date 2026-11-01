/**
 * Manifest validation and application.
 *
 * The point of these cases is what the device refuses: an unknown member, a
 * duplicate name, a signed document this build cannot verify, an empty-array
 * free core entry, a fragment id a plugin may not own, and the connector itself.
 * Application is exercised against a fake plugin manager so a failed upgrade can
 * be shown to restore the previous version.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_PACKAGE,
  applyManifest,
  cleanupInstallLeftovers,
  downloadArtifact,
  loadManifestSchema,
  planApplication,
  validateManifest,
  type ApplyDeps,
  type ChangeOutcome,
  type InstalledBundle,
  type Manifest,
  type ManifestPlugin,
} from '../../hub/plugins/hub-connector/src/manifest.ts'
import { renderOverlay } from '../../hub/plugins/hub-connector/src/overlay.ts'
import type { ManagedPluginRecord } from '../../hub/plugins/hub-connector/src/state.ts'

const SCHEMA = loadManifestSchema(resolve(import.meta.dirname, '../../hub/plugins/hub-connector'))

/** A minimal valid document; cases override one member at a time. */
function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision: 12,
    issuedAt: '2026-10-22T00:00:00.000Z',
    plugins: [
      {
        name: '@local/dsh-memory',
        version: '0.1.2',
        level: 'core',
        artifact: { url: 'https://hub.example/a.tgz', sha256: 'a'.repeat(64), bytes: 100 },
      },
    ],
    ...overrides,
  }
}

/** Validate and unwrap, failing the test on a rejection. */
function accepted(overrides: Record<string, unknown> = {}, deviceId: string | null = null): Manifest {
  const result = validateManifest(document(overrides), { schema: SCHEMA, dshVersion: '0.2.2', deviceId })
  if (!result.ok) throw new Error(`manifest rejected: ${JSON.stringify(result.issues)}`)
  return result.manifest
}

describe('manifest validation', () => {
  it('accepts the D3 example document', () => {
    const example = {
      schemaVersion: 1,
      revision: 1234,
      issuedAt: '2026-10-21T12:00:00.000Z',
      expiresAt: '2026-11-04T12:00:00.000Z',
      device: { deviceId: 'dv_9f3c0c1e2b1a4c119a512b0f4f0c8d11', userId: 7 },
      notice: '本周把 Claude Code 桥接插件升到 0.5.1',
      plugins: [
        {
          name: '@local/dsh-memory',
          version: '0.1.2',
          level: 'core',
          enabled: true,
          bundleOrder: 10,
          needsRestart: false,
          minDsh: '>=0.2.1-rc.2 <0.3.0',
          artifact: { url: 'https://hub.example/a.tgz', sha256: 'a'.repeat(64), bytes: 123_456, filename: 'dsh-memory-0.1.2.tgz' },
          config: [{ id: 'dsh-memory', config: { topK: 8 } }],
        },
        {
          name: '@local/dsh-claude-pilot',
          version: '0.5.1',
          level: 'default',
          bundleOrder: 20,
          needsRestart: true,
          artifact: { url: 'https://hub.example/b.tgz', sha256: 'b'.repeat(64), bytes: 73_600 },
        },
        {
          name: '@local/dsh-codex-pilot',
          version: '0.3.1',
          level: 'optional',
          enabled: false,
          artifact: { url: 'https://hub.example/c.tgz', sha256: 'c'.repeat(64), bytes: 75_366 },
        },
      ],
      uninstall: ['@local/dsh-image-gen'],
      config: {
        allowlistVersion: 1,
        digest: `sha256:${'d'.repeat(64)}`,
        fragments: [
          { id: 'llm-pi-ai', mode: 'enforce', config: { providers: {} } },
          { id: 'claude-pilot', mode: 'default', config: { permissionMode: 'acceptEdits' } },
        ],
      },
      app: { channel: 'nightly', minVersion: '0.2.1', minVersionHard: false, targetVersion: '0.2.2-rc.1', feedUrl: 'https://hub.example/feeds/win-x64/' },
    }
    const result = validateManifest(example, { schema: SCHEMA, dshVersion: '0.2.2', deviceId: 'dv_9f3c0c1e2b1a4c119a512b0f4f0c8d11' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.plugins).toHaveLength(3)
    expect(result.manifest.config.fragments).toHaveLength(2)
    // The optional entry stays as offered, not installed.
    expect(result.manifest.plugins[2]?.enabled).toBe(false)
  })

  it('rejects an unknown member, a bad hash, and a missing artifact', () => {
    expect(validateManifest(document({ extra: true }), { schema: SCHEMA, dshVersion: '0.2.2', deviceId: null }).ok).toBe(false)
    const badHash = document()
    ;(badHash.plugins as ManifestPlugin[])[0] = {
      ...(badHash.plugins as ManifestPlugin[])[0]!,
      artifact: { url: 'https://hub.example/a.tgz', sha256: 'nope', bytes: 1 },
    }
    expect(validateManifest(badHash, { schema: SCHEMA, dshVersion: '0.2.2', deviceId: null }).ok).toBe(false)
    const missing = document()
    ;(missing.plugins as ManifestPlugin[])[0] = { ...(missing.plugins as ManifestPlugin[])[0]!, artifact: undefined } as never
    expect(validateManifest(missing, { schema: SCHEMA, dshVersion: '0.2.2', deviceId: null }).ok).toBe(false)
  })

  it('refuses a signed manifest this build cannot verify', () => {
    const result = validateManifest(document({
      signature: { alg: 'ed25519', keyId: 'k1', value: 'AAAA', signedAt: '2026-10-22T00:00:00.000Z' },
    }), { schema: SCHEMA, dshVersion: '0.2.2', deviceId: null })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some(issue => issue.path === '/signature')).toBe(true)
  })

  it('refuses a manifest bound to another device and a duplicate plugin name', () => {
    const other = validateManifest(document({ device: { deviceId: 'dv_ffffffffffffffffffffffffffffffff' } }), {
      schema: SCHEMA, dshVersion: '0.2.2', deviceId: 'dv_0123456789abcdef0123456789abcdef',
    })
    expect(other.ok).toBe(false)
    const duplicate = document()
    const first = (duplicate.plugins as ManifestPlugin[])[0]!
    ;(duplicate.plugins as ManifestPlugin[]).push({ ...first })
    expect(validateManifest(duplicate, { schema: SCHEMA, dshVersion: '0.2.2', deviceId: null }).ok).toBe(false)
  })

  it('drops fragments a plugin may not own and ignores the connector itself', () => {
    const result = validateManifest(document({
      plugins: [
        {
          name: '@local/dsh-memory',
          version: '0.1.2',
          level: 'core',
          artifact: { url: 'https://hub.example/a.tgz', sha256: 'a'.repeat(64), bytes: 100 },
          config: [{ id: 'llm-pi-ai', config: { providers: {} } }, { id: 'dsh-memory', config: { topK: 4 } }],
        },
        {
          name: CONNECTOR_PACKAGE,
          version: '9.9.9',
          level: 'core',
          artifact: { url: 'https://hub.example/x.tgz', sha256: 'e'.repeat(64), bytes: 1 },
        },
      ],
      uninstall: [CONNECTOR_PACKAGE],
    }), { schema: SCHEMA, dshVersion: '0.2.2', deviceId: null })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.plugins.map(plugin => plugin.name)).toEqual(['@local/dsh-memory'])
    expect(result.manifest.plugins[0]?.config.map(fragment => fragment.id)).toEqual(['dsh-memory'])
    expect(result.manifest.uninstall).toEqual([])
    expect(result.warnings.join('\n')).toMatch(/never delivered by the Hub/u)
  })

  it('refuses a core entry a document tries to disable and a fragment list with a duplicate id', () => {
    const disabled = document()
    ;(disabled.plugins as ManifestPlugin[])[0] = { ...(disabled.plugins as ManifestPlugin[])[0]!, level: 'core', enabled: false }
    expect(validateManifest(disabled, { schema: SCHEMA, dshVersion: '0.2.2', deviceId: null }).ok).toBe(false)
    const duplicated = document({
      config: { fragments: [{ id: 'a', mode: 'enforce', config: {} }, { id: 'a', mode: 'default', config: {} }] },
    })
    expect(validateManifest(duplicated, { schema: SCHEMA, dshVersion: '0.2.2', deviceId: null }).ok).toBe(false)
  })
})

describe('application planning and application', () => {
  const managed: ManagedPluginRecord[] = [
    { name: '@local/dsh-old', version: '0.0.9', source: 'hub-default', enabled: true },
  ]

  it('plans install, removal of Hub-delivered packages only, and toggles', () => {
    const manifest = accepted({
      plugins: [
        { name: '@local/dsh-memory', version: '0.1.2', level: 'core', artifact: { url: 'https://hub.example/a.tgz', sha256: 'a'.repeat(64), bytes: 100 } },
        { name: '@local/dsh-codex-pilot', version: '0.3.1', level: 'optional', enabled: false, artifact: { url: 'https://hub.example/c.tgz', sha256: 'c'.repeat(64), bytes: 10 } },
      ],
    })
    const installed: InstalledBundle[] = [
      { name: '@local/dsh-old', version: '0.0.9', enabled: true, removable: true },
      { name: 'user-plugin', version: '1.0.0', enabled: false, removable: true },
    ]
    const plan = planApplication(manifest, installed, managed)
    expect(plan.install.map(plugin => plugin.name)).toEqual(['@local/dsh-memory'])
    // A user-installed package is never removed, even though the manifest does not name it.
    expect(plan.remove).toEqual(['@local/dsh-old'])
  })

  it('downloads, verifies, and applies an archive through the plugin manager', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hub-connector-'))
    const cache = join(directory, 'cache')
    mkdirSync(cache, { recursive: true })
    const bytes = Buffer.from('archive-bytes')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const fetched = await downloadArtifact(
      { url: 'https://hub.example/a.tgz', sha256, bytes: bytes.byteLength },
      cache,
      { fetchImpl: async () => new Response(bytes) },
    )
    expect(readFileSync(fetched).byteLength).toBe(bytes.byteLength)
    // A digest mismatch must not touch the cache.
    await expect(downloadArtifact(
      { url: 'https://hub.example/b.tgz', sha256: 'f'.repeat(64), bytes: bytes.byteLength },
      cache,
      { fetchImpl: async () => new Response(bytes) },
    )).rejects.toThrow(/digest/u)

    const calls: string[] = []
    const deps: ApplyDeps = {
      listBundles: async () => [{ name: '@local/dsh-old', version: '0.0.9', enabled: true, removable: true }],
      install: async (spec): Promise<ChangeOutcome> => { calls.push(`install:${spec}`); return { changed: true } },
      remove: async (name): Promise<ChangeOutcome> => { calls.push(`remove:${name}`); return { changed: true } },
      setEnabled: async (name, enabled): Promise<ChangeOutcome> => { calls.push(`toggle:${name}:${String(enabled)}`); return { changed: true } },
      fetchArtifact: async () => fetched,
      readUserPatch: () => '- id: llm-pi-ai\n  config: { providers: {} }\n',
      writeOverlay: () => undefined,
      readOverlay: () => 'previous',
      extraFragments: () => [],
      dshVersion: '0.2.2',
      previousManaged: managed,
      profile: directory,
    }
    const manifest = accepted({
      config: {
        fragments: [
          { id: 'llm-pi-ai', mode: 'default', config: { providers: {} } },
          { id: 'agent-default-model', mode: 'enforce', config: { provider: 'hub', model: 'x' } },
        ],
      },
    })
    const outcome = await applyManifest(manifest, deps)
    expect(outcome.applyState).toBe('applied')
    expect(outcome.managed.map(entry => entry.name)).toEqual(['@local/dsh-memory'])
    // The user declared `llm-pi-ai`, so the default fragment yields to it.
    expect(outcome.skippedFragments).toEqual(['llm-pi-ai'])
    expect(calls).toContain('install:file:' + fetched)
    expect(calls).toContain('remove:@local/dsh-old')
    expect(outcome.restartReason).not.toBeNull()
  })

  it('asks for a restart only when the delivered rows change, not when a revision moves on', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hub-connector-revision-'))
    const fragments = [{ id: 'agent-default-model', mode: 'enforce' as const, config: { provider: 'hub', model: 'x' } }]
    // The overlay the previous revision wrote, generated by the same renderer.
    const previous = renderOverlay({ revision: 3, fragments, connectorRow: true }, { userDeclared: new Set() }).text
    const written: string[] = []
    const deps: ApplyDeps = {
      listBundles: async () => [],
      install: async (): Promise<ChangeOutcome> => ({ changed: false }),
      remove: async (): Promise<ChangeOutcome> => ({ changed: false }),
      setEnabled: async (): Promise<ChangeOutcome> => ({ changed: false }),
      fetchArtifact: async () => '/cache/none.tgz',
      readUserPatch: () => '',
      writeOverlay: (text) => { written.push(text) },
      readOverlay: () => previous,
      dshVersion: '0.2.2',
      previousManaged: [],
      profile: directory,
    }
    const unchanged = await applyManifest(accepted({ revision: 4, plugins: [], config: { fragments } }), deps)
    expect(unchanged.restartReason).toBeNull()
    expect(written[0]).toContain('# revision: 4')
    const changed = await applyManifest(accepted({
      revision: 5, plugins: [], config: { fragments: [...fragments, { id: 'dsh-memory', mode: 'enforce', config: { topK: 4 } }] },
    }), deps)
    expect(changed.restartReason).toBe('configuration changed')
  })

  it.each(['0.1.2', '0.1.1'])('checks the actual version when another instance installed the package (%s)', async (version) => {
    let installed = false
    const deps: ApplyDeps = {
      listBundles: async () => installed ? [{ name: '@local/dsh-memory', version, enabled: true, removable: true }] : [],
      install: async () => { installed = true; return { changed: false, error: 'already-installed' } },
      remove: async () => ({ changed: false }),
      setEnabled: async () => ({ changed: false }),
      fetchArtifact: async () => '/cache/new.tgz',
      readUserPatch: () => '', writeOverlay: () => undefined, readOverlay: () => undefined,
      dshVersion: '0.2.2', previousManaged: [], profile: mkdtempSync(join(tmpdir(), 'hub-connector-race-')),
    }
    const outcome = await applyManifest(accepted(), deps)
    expect(outcome.applyState).toBe(version === '0.1.2' ? 'applied' : 'failed')
    expect(outcome.managed).toHaveLength(version === '0.1.2' ? 1 : 0)
  })

  it('reports partial failure and restores the previous version when an upgrade fails', async () => {
    const calls: string[] = []
    const profileDir = mkdtempSync(join(tmpdir(), 'hub-connector-'))
    const deps: ApplyDeps = {
      listBundles: async () => [{ name: '@local/dsh-memory', version: '0.1.1', enabled: true, removable: true }],
      install: async (spec): Promise<ChangeOutcome> => {
        calls.push(`install:${spec}`)
        if (spec.endsWith('new.tgz')) return { changed: false, error: 'install-failed' }
        return { changed: true }
      },
      remove: async (name): Promise<ChangeOutcome> => { calls.push(`remove:${name}`); return { changed: true } },
      setEnabled: async (): Promise<ChangeOutcome> => ({ changed: true }),
      fetchArtifact: async () => '/cache/new.tgz',
      readUserPatch: () => '',
      writeOverlay: () => undefined,
      readOverlay: () => undefined,
      dshVersion: '0.2.2',
      previousManaged: [{ name: '@local/dsh-memory', version: '0.1.1', source: 'hub-core', enabled: true }],
      profile: profileDir,
    }
    // The profile manifest records the previous archive so the rollback has a spec to reinstall.
    writeFileSync(join(profileDir, 'old.tgz'), '')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'profile', private: true,
      dependencies: { '@local/dsh-memory': `file:${join(profileDir, 'old.tgz')}` },
    }))
    const manifest = accepted()
    const outcome = await applyManifest(manifest, deps)
    expect(outcome.applyState).toBe('failed')
    expect(outcome.errorCode).toBe('plugin_install_failed')
    expect(calls).toContain('remove:@local/dsh-memory')
    expect(calls).toContain(`install:file:${join(profileDir, 'old.tgz')}`)
  })
})

describe('restart need follows the change that happened', () => {
  /** One plugin entry whose metadata declares it needs a restart. */
  function restarting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: '@local/dsh-memory',
      version: '0.1.2',
      level: 'core',
      needsRestart: true,
      artifact: { url: 'https://hub.example/a.tgz', sha256: 'a'.repeat(64), bytes: 100 },
      ...overrides,
    }
  }

  /** Recording deps over one installed set; `overrides` replaces one manager call. */
  function deps(
    installed: InstalledBundle[],
    calls: string[],
    overrides: Partial<Pick<ApplyDeps, 'install' | 'remove' | 'setEnabled'>> = {},
    previousManaged: ManagedPluginRecord[] = [],
  ): ApplyDeps {
    return {
      listBundles: async () => installed,
      install: async (spec): Promise<ChangeOutcome> => { calls.push(`install:${spec}`); return { changed: true } },
      remove: async (name): Promise<ChangeOutcome> => { calls.push(`remove:${name}`); return { changed: true } },
      setEnabled: async (name, enabled): Promise<ChangeOutcome> => { calls.push(`toggle:${name}:${String(enabled)}`); return { changed: true } },
      fetchArtifact: async () => '/cache/a.tgz',
      readUserPatch: () => '',
      writeOverlay: () => undefined,
      readOverlay: () => undefined,
      dshVersion: '0.2.2',
      previousManaged,
      profile: mkdtempSync(join(tmpdir(), 'hub-connector-restart-')),
      ...overrides,
    }
  }

  it('does not raise a restart for a needsRestart plugin that is already installed unchanged', async () => {
    const calls: string[] = []
    const manifest = accepted({ plugins: [restarting()] })
    const outcome = await applyManifest(manifest, deps(
      [{ name: '@local/dsh-memory', version: '0.1.2', enabled: true, removable: true }], calls,
    ))
    expect(outcome.applyState).toBe('applied')
    // Replaying the same manifest is not a change: no manager call and no prompt.
    expect(outcome.restartReason).toBeNull()
    expect(calls).toEqual([])
  })

  it('raises one restart when the needsRestart plugin is actually installed', async () => {
    const calls: string[] = []
    const outcome = await applyManifest(accepted({ plugins: [restarting()] }), deps([], calls))
    expect(outcome.restartReason).toBe('@local/dsh-memory needs a restart')
    expect(calls).toEqual(['install:file:/cache/a.tgz'])
  })

  it('raises one restart when the manager reports an upgrade needing one', async () => {
    const calls: string[] = []
    // The metadata does not ask for one; the manager's own outcome decides.
    const outcome = await applyManifest(accepted({ plugins: [restarting({ needsRestart: false })] }), deps(
      [{ name: '@local/dsh-memory', version: '0.1.1', enabled: true, removable: true }], calls,
      { install: async (spec): Promise<ChangeOutcome> => { calls.push(`install:${spec}`); return { changed: true, application: 'restart-required' } } },
      [{ name: '@local/dsh-memory', version: '0.1.1', source: 'hub-core', enabled: true }],
    ))
    expect(outcome.restartReason).toBe('@local/dsh-memory needs a restart')
  })

  it('raises a restart for a toggle the manager says needs one, even without the flag', async () => {
    const calls: string[] = []
    const outcome = await applyManifest(accepted({
      plugins: [restarting({ needsRestart: false, enabled: false, level: 'default' })],
    }), deps(
      [{ name: '@local/dsh-memory', version: '0.1.2', enabled: true, removable: true }], calls,
      { setEnabled: async (name, enabled): Promise<ChangeOutcome> => { calls.push(`toggle:${name}:${String(enabled)}`); return { changed: true, application: 'restart-required' } } },
    ))
    expect(calls).toEqual(['toggle:@local/dsh-memory:false'])
    expect(outcome.restartReason).toBe('@local/dsh-memory needs a restart')
  })

  it('does not raise a restart when a toggle changed nothing', async () => {
    const outcome = await applyManifest(accepted({
      plugins: [restarting({ enabled: false, level: 'default' })],
    }), deps(
      [{ name: '@local/dsh-memory', version: '0.1.2', enabled: true, removable: true }], [],
      { setEnabled: async (): Promise<ChangeOutcome> => ({ changed: false }) },
    ))
    expect(outcome.restartReason).toBeNull()
  })

  it('raises a restart for an uninstall the manager completes with one owed', async () => {
    const outcome = await applyManifest(accepted({
      revision: 13,
      plugins: [],
      uninstall: ['@local/dsh-old'],
    }), deps(
      [{ name: '@local/dsh-old', version: '0.0.9', enabled: true, removable: true }], [],
      { remove: async (): Promise<ChangeOutcome> => ({ changed: true, application: 'restart-required' }) },
      [{ name: '@local/dsh-old', version: '0.0.9', source: 'hub-default', enabled: true }],
    ))
    expect(outcome.restartReason).toBe('a plugin removal needs a restart')
  })

  it('does not raise a restart for skipped, failed, or unadopted needsRestart entries', async () => {
    const calls: string[] = []
    // optional + disabled: offered, not installed. Wrong minDsh: skipped. The third
    // fails to install. None of them is a change, so none may ask for a restart.
    const manifest = accepted({
      plugins: [
        restarting({ name: '@local/dsh-optional', level: 'optional', enabled: false }),
        restarting({ name: '@local/dsh-future', minDsh: '>=99.0.0' }),
        restarting({ name: '@local/dsh-broken' }),
      ],
    })
    const outcome = await applyManifest(manifest, deps([], calls, {
      install: async (spec): Promise<ChangeOutcome> => {
        calls.push(`install:${spec}`)
        return spec.endsWith('a.tgz') ? { changed: false, error: 'install-failed' } : { changed: true }
      },
    }))
    expect(calls).toEqual(['install:file:/cache/a.tgz'])
    expect(outcome.applyState).toBe('failed')
    expect(outcome.restartReason).toBeNull()
  })

  it('does not raise a restart when an installed newer bundle is not downgraded', async () => {
    const outcome = await applyManifest(accepted({ plugins: [restarting()] }), deps(
      [{ name: '@local/dsh-memory', version: '0.2.0', enabled: true, removable: true }], [],
      {}, [{ name: '@local/dsh-memory', version: '0.2.0', source: 'bundled', enabled: true }],
    ))
    expect(outcome.restartReason).toBeNull()
  })

  it('keeps the real restart need of another successful change beside a skipped entry', async () => {
    const outcome = await applyManifest(accepted({
      plugins: [
        restarting({ name: '@local/dsh-future', minDsh: '>=99.0.0' }),
        restarting(),
      ],
    }), deps([], []))
    expect(outcome.restartReason).toBe('@local/dsh-memory needs a restart')
  })
})

describe('artifact download credentials', () => {
  const bytes = Buffer.from('archive-bytes')
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  /** One download against a fetch double, returning the headers it received. */
  async function download(url: string, authorization?: { origin: string; token: string }): Promise<Record<string, string>> {
    const cache = mkdtempSync(join(tmpdir(), 'hub-download-'))
    let seen: Record<string, string> = {}
    await downloadArtifact({ url, sha256, bytes: bytes.byteLength }, cache, {
      fetchImpl: async (_input, init) => {
        seen = (init?.headers ?? {}) as Record<string, string>
        return new Response(bytes)
      },
      ...authorization === undefined ? {} : { authorization },
    })
    return seen
  }

  it('sends the device token to the Hub origin the manifest came from', async () => {
    const headers = await download('https://hub.example/api/desktop/plugins/a.tgz', {
      origin: 'https://hub.example',
      token: 'dsh_dev_token',
    })
    expect(headers.authorization).toBe('Bearer dsh_dev_token')
  })

  it('never sends the token to another origin', async () => {
    const foreign = await download('https://cdn.example/a.tgz', {
      origin: 'https://hub.example',
      token: 'dsh_dev_token',
    })
    expect(foreign.authorization).toBeUndefined()
    // No credentials configured: the request stays anonymous even for the Hub itself.
    const anonymous = await download('https://hub.example/api/desktop/plugins/a.tgz')
    expect(anonymous.authorization).toBeUndefined()
    // A different scheme/port is a different origin, too.
    const otherPort = await download('https://hub.example:8443/a.tgz', {
      origin: 'https://hub.example',
      token: 'dsh_dev_token',
    })
    expect(otherPort.authorization).toBeUndefined()
  })
})

describe('plugin removal leftovers', () => {
  it('cleans the file: dependency, the package directory, and its .bin link', () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hub-connector-clean-'))
    const packageDir = join(profileDir, 'node_modules', '@local', 'dsh-old')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'index.js'), 'export {}')
    const binDir = join(profileDir, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(profileDir, 'old.tgz'), '')
    symlinkSync(join(packageDir, 'index.js'), join(binDir, 'dsh-old'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'profile',
      private: true,
      dependencies: { '@local/dsh-old': 'file:./old.tgz', '@local/keep': 'file:./keep.tgz' },
    }, null, 2))

    const removed = cleanupInstallLeftovers('@local/dsh-old', profileDir)
    expect(removed).toContain('@local/dsh-old dependency')
    expect(removed).toContain('@local/dsh-old package directory')
    expect(removed).toContain('node_modules/.bin/dsh-old')
    const dependencies = (JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }).dependencies
    expect(dependencies['@local/dsh-old']).toBeUndefined()
    expect(dependencies['@local/keep']).toBe('file:./keep.tgz')
    expect(existsSync(packageDir)).toBe(false)
  })

  it('leaves a registry-installed dependency alone', () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hub-connector-clean-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'profile',
      private: true,
      dependencies: { 'user-plugin': '^1.0.0' },
    }))
    expect(cleanupInstallLeftovers('user-plugin', profileDir)).toEqual([])
    expect((JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }).dependencies['user-plugin']).toBe('^1.0.0')
  })

  it('treats bundle-in-use as a pending removal, not a failure', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hub-connector-busy-'))
    const deps: ApplyDeps = {
      listBundles: async () => [{ name: '@local/dsh-old', version: '0.0.9', enabled: true, removable: true }],
      install: async (): Promise<ChangeOutcome> => ({ changed: false }),
      remove: async (): Promise<ChangeOutcome> => ({ changed: false, error: 'bundle-in-use' }),
      setEnabled: async (): Promise<ChangeOutcome> => ({ changed: false }),
      fetchArtifact: async () => '/cache/none.tgz',
      readUserPatch: () => '',
      writeOverlay: () => undefined,
      readOverlay: () => undefined,
      dshVersion: '0.2.2',
      previousManaged: [{ name: '@local/dsh-old', version: '0.0.9', source: 'hub-default', enabled: true }],
      profile: profileDir,
    }
    const outcome = await applyManifest(accepted(), deps)
    // Applied, not failed: the bundle simply outlives this Host session.
    expect(outcome.applyState).toBe('applied')
    expect(outcome.errorCount).toBe(0)
    expect(outcome.errorCode).toBeNull()
    expect(outcome.restartReason).toContain('restart')
    // The record stays, so the next apply derives the removal again and finishes it.
    expect(outcome.managed.map(entry => entry.name)).toContain('@local/dsh-old')
    expect(outcome.pendingRemovals).toEqual(['@local/dsh-old'])
  })

  it('cleans leftovers after a removal the manager performed', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hub-connector-removed-'))
    mkdirSync(join(profileDir, 'node_modules', '@local', 'dsh-old'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'profile',
      private: true,
      dependencies: { '@local/dsh-old': 'file:./old.tgz' },
    }, null, 2))
    const deps: ApplyDeps = {
      listBundles: async () => [],
      install: async (): Promise<ChangeOutcome> => ({ changed: false }),
      remove: async (): Promise<ChangeOutcome> => ({ changed: true }),
      setEnabled: async (): Promise<ChangeOutcome> => ({ changed: false }),
      fetchArtifact: async () => '/cache/none.tgz',
      readUserPatch: () => '',
      writeOverlay: () => undefined,
      readOverlay: () => undefined,
      dshVersion: '0.2.2',
      previousManaged: [{ name: '@local/dsh-old', version: '0.0.9', source: 'hub-default', enabled: true }],
      profile: profileDir,
    }
    const outcome = await applyManifest(accepted(), deps)
    expect(outcome.applyState).toBe('applied')
    expect(existsSync(join(profileDir, 'node_modules', '@local', 'dsh-old'))).toBe(false)
    expect(outcome.pendingRemovals).toEqual([])
    expect((JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }).dependencies['@local/dsh-old']).toBeUndefined()
  })
})
