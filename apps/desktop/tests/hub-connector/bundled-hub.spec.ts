/**
 * The bundled baseline against the Hub (design §4.2, §4.3).
 *
 * The installer's plugins live beside the connector, the Hub's manifest arrives
 * later, and the two must not undo each other: the baseline installs before any
 * account exists, a manifest takes the package over without downgrading it, an
 * unmentioned package keeps its record, and an explicit uninstall is remembered.
 * The model snapshot follows the same rule: it renders until a manifest delivers
 * its own model fragments, then it yields.
 */

import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../../packages/credentials/credentials/tests/memory.ts'
import { HubAccount, type HubGrant } from '../../hub/plugins/hub-connector/src/account.ts'
import { HubConnector, type ConnectorHost } from '../../hub/plugins/hub-connector/src/connector.ts'
import { HUB_OVERLAY_FILENAME } from '../../hub/plugins/hub-connector/src/overlay.ts'
import { initialState, loadState, saveState, type HubState } from '../../hub/plugins/hub-connector/src/state.ts'

/** One loopback Hub that serves the endpoints this suite drives. */
interface Lab {
  readonly origin: string
  readonly reports: { plugins?: { name: string; version: string; source: string; state: string }[] }[]
  readonly installs: string[]
  readonly removals: string[]
  readonly selections: { provider: string; model: string; reasoningEffort?: string }[]
  readonly bundles: { name: string; version: string; enabled: boolean }[]
  manifest: Record<string, unknown>
  readonly server: ReturnType<typeof createServer>
}

/** Start a Hub double with one manifest revision and a recording report endpoint. */
async function startLab(manifest: Record<string, unknown>, models: readonly string[] = []): Promise<Lab> {
  const reports: Lab['reports'] = []
  const lab = {
    origin: '',
    reports,
    installs: [],
    removals: [],
    selections: [],
    bundles: [],
    manifest,
  } as unknown as Lab
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/desktop/manifest') {
      response.setHeader('etag', `"revision-${String((lab.manifest as { revision?: number }).revision)}"`)
      response.end(JSON.stringify(lab.manifest))
      return
    }
    if (request.url === '/api/desktop/devices/report') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        reports.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Lab['reports'][number])
        response.end(JSON.stringify({ desiredRevision: (lab.manifest as { revision?: number }).revision, reportIntervalSec: 900 }))
      })
      return
    }
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: models.map(id => ({ id, display_name: `relay ${id}` })) }))
      return
    }
    response.writeHead(404).end('{"error":{"code":"NOT_FOUND","message":"not in the lab"}}')
  })
  await new Promise<void>((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing server address')
  return Object.assign(lab, { server, origin: `http://127.0.0.1:${String(address.port)}` })
}

/** Write one bundled archive plus the manifest the connector reads. */
function bundledDirectory(directory: string, declarations: readonly { package: string; version: string; level: string }[]): void {
  mkdirSync(directory, { recursive: true })
  const files = declarations.map((entry) => {
    const file = `${entry.package.replaceAll('/', '-').replace('@', '')}-${entry.version}.tgz`
    const bytes = Buffer.from(`archive:${entry.package}@${entry.version}`)
    writeFileSync(join(directory, file), bytes)
    return { ...entry, file, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  writeFileSync(join(directory, 'bundled-plugins.json'), `${JSON.stringify(files, undefined, 2)}\n`)
}

/** The model snapshot file the packaging step writes beside the archives. */
function modelSnapshot(directory: string): void {
  writeFileSync(join(directory, 'bundled-models.json'), JSON.stringify({
    schemaVersion: 2,
    llmPiAi: {
      providers: {
        'hub-max': {
          displayName: 'DSH Hub',
          api: 'openai-completions',
          reasoning: 'max',
          models: [{
            id: 'deepseek-v4.1-flash@relay',
            name: 'DeepSeek V4.1 Flash · relay',
            reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
          }],
        },
      },
    },
    agentDefaultModel: { provider: 'hub-max', model: 'deepseek-v4.1-flash@relay', reasoningEffort: 'max' },
  }))
}

/** Everything one connector run needs. */
interface Rig {
  readonly profile: string
  readonly host: ConnectorHost
  readonly lab: Lab
  readonly state: () => HubState
  readonly overlay: () => string
  /** Bundle enablement calls the connector made, for the one-reload assertions. */
  readonly toggles: string[]
  create: (grant: HubGrant | undefined) => HubConnector
}

/**
 * Build the host: a fake Hub, an in-memory credential store, and a plugin
 * manager whose installs/removals are recorded on the lab.
 */
function rig(options: {
  readonly lab: Lab
  readonly bundled?: string
  readonly installs?: readonly { name: string; version: string; enabled: boolean }[]
  readonly managed?: HubState['managed']
  readonly packageManager?: { readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }
  readonly toggles?: string[]
}): Rig {
  const profile = mkdtempSync(join(tmpdir(), 'hub-bundled-hub-'))
  const fallback = initialState({ osLabel: 'Windows 11', installId: 'install-1' })
  saveState(profile, {
    ...fallback,
    deviceId: 'dv_0123456789abcdef0123456789abcdef',
    ...options.managed === undefined ? {} : { managed: options.managed },
  })
  const context = new Context()
  const credentials = new MemoryCredentials(context, { HUB_MK_HUB: 'sk-dsh-test' })
  const bundles = [...options.installs ?? []]
  const manager = {
    listBundles: async () => bundles,
    installBundle: async (spec: string) => {
      options.lab.installs.push(spec)
      const file = spec.slice(spec.lastIndexOf('/') + 1)
      const match = /^(.*)-\d+\.\d+\.\d+\.tgz$/u.exec(file)
      const names: Record<string, string> = { 'local-dsh-memory': '@local/dsh-memory', 'dsh-better-sidebar': 'dsh-better-sidebar' }
      const version = /-(\d+\.\d+\.\d+)\.tgz$/u.exec(file)?.[1] ?? '0.0.0'
      bundles.push({ name: names[match?.[1] ?? ''] ?? file, version, enabled: true })
      return { changed: true }
    },
    removeBundle: async (name: string) => {
      options.lab.removals.push(name)
      const index = bundles.findIndex(bundle => bundle.name === name)
      if (index >= 0) bundles.splice(index, 1)
      return { changed: true }
    },
    setBundleEnabled: async (name: string, enabled: boolean) => {
      options.toggles?.push(name)
      const bundle = bundles.find(entry => entry.name === name)
      if (bundle !== undefined) bundle.enabled = enabled
      return { changed: true }
    },
  }
  const build = {
    appVersion: '0.2.1-rc.2', appChannel: 'latest', runtimeVersion: '0.2.1-rc.2',
    builtHubOrigin: options.lab.origin, osLabel: 'Windows 11', installId: 'install-1',
    schemaDirectory: resolve(import.meta.dirname, '../../hub/plugins/hub-connector'),
  } as const
  let selected = false
  const host: ConnectorHost = {
    profile,
    build,
    environment: {},
    account: {
      build, environment: {}, credentials, registerRoute: () => () => undefined,
      hubOrigin: () => options.lab.origin,
      readState: () => loadState(profile, fallback),
      writeState: (state) => { saveState(profile, state) },
      emit: () => undefined, changed: () => undefined,
      now: () => new Date('2026-10-22T01:00:00Z'), random: size => Buffer.alloc(size),
    },
    pluginManager: manager,
    ...options.bundled === undefined ? {} : { bundledDirectory: options.bundled },
    ...options.packageManager === undefined ? {} : { packageManager: options.packageManager },
    hasDefaultModel: async () => selected,
    selectDefaultModel: async (selection) => {
      options.lab.selections.push(selection)
      selected = true
    },
  }
  return {
    profile,
    host,
    lab: options.lab,
    toggles: options.toggles ?? [],
    state: () => loadState(profile, fallback),
    overlay: () => {
      try {
        return readFileSync(join(profile, HUB_OVERLAY_FILENAME), 'utf8')
      } catch {
        return ''
      }
    },
    create: grant => new HubConnector(host, (accountHost) => {
      const account = new HubAccount(accountHost)
      vi.spyOn(account, 'readGrant').mockResolvedValue(grant)
      return account
    }),
  }
}

/** One device grant bound to the lab origin. */
function grantFor(lab: Lab): HubGrant {
  return {
    version: 1, token: 'test-device-token', hubOrigin: lab.origin,
    deviceId: 'dv_0123456789abcdef0123456789abcdef',
    expiresAt: '2026-11-01T00:00:00Z', absoluteExpiresAt: '2026-12-01T00:00:00Z',
    user: { username: 'test', displayName: 'Test', role: 'user', roleLabel: '' }, wallet: null,
  }
}

/** A minimal valid manifest. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision: 1,
    issuedAt: '2026-10-22T00:00:00.000Z',
    plugins: [],
    uninstall: [],
    config: { fragments: [] },
    ...overrides,
  }
}

/** Close the lab and remove its profile. */
async function close(lab: Lab, profile: string | undefined, connector: HubConnector | undefined): Promise<void> {
  connector?.stop()
  lab.server.closeAllConnections()
  await new Promise<void>((resolveClose, reject) => { lab.server.close((error) => { if (error) reject(error); else resolveClose() }) })
  if (profile !== undefined) rmSync(profile, { recursive: true, force: true })
}

describe('bundled plugins before sign-in (design §4.2)', () => {
  it('installs the installer set with no account at all and records source bundled', async () => {
    const lab = await startLab(manifest())
    const bundled = join(mkdtempSync(join(tmpdir(), 'hub-bundled-set-')), 'hub-plugins')
    bundledDirectory(bundled, [
      { package: '@local/dsh-memory', version: '0.1.3', level: 'default' },
      { package: 'dsh-better-sidebar', version: '0.28.0', level: 'core' },
    ])
    const harness = rig({ lab, bundled })
    const connector = harness.create(undefined)
    try {
      await connector.start()
      // Signed out: the baseline still landed, and nothing was reported or fetched.
      expect(lab.installs).toHaveLength(2)
      expect(lab.reports).toEqual([])
      expect(harness.state().managed).toEqual([
        { name: '@local/dsh-memory', version: '0.1.3', source: 'bundled', enabled: true },
        { name: 'dsh-better-sidebar', version: '0.28.0', source: 'bundled', enabled: true },
      ])
    } finally {
      await close(lab, harness.profile, connector)
    }
  })
})

describe('a manifest naming a bundled package (design §4.2)', () => {
  it('does not downgrade a newer installed version and reports the bundled version', async () => {
    const lab = await startLab(manifest({
      plugins: [{
        name: '@local/dsh-memory', version: '0.1.3', level: 'default', enabled: true,
        artifact: { url: 'https://hub.example/a.tgz', sha256: 'a'.repeat(64), bytes: 10 },
      }],
    }))
    const harness = rig({
      lab,
      installs: [{ name: '@local/dsh-memory', version: '0.2.0', enabled: true }],
      managed: [{ name: '@local/dsh-memory', version: '0.2.0', source: 'bundled', enabled: true }],
    })
    const connector = harness.create(grantFor(lab))
    try {
      await connector.pullManifest()
      await vi.waitFor(() => { expect(lab.reports.length).toBeGreaterThan(0) })
      expect(lab.installs).toEqual([])
      expect(harness.state().managed).toEqual([
        { name: '@local/dsh-memory', version: '0.2.0', source: 'bundled', enabled: true },
      ])
      expect(lab.reports[0]?.plugins).toEqual([
        { name: '@local/dsh-memory', version: '0.2.0', source: 'bundled', state: 'enabled' },
      ])
    } finally {
      await close(lab, harness.profile, connector)
    }
  })

  it('keeps an unmentioned bundled package and never uninstalls it implicitly', async () => {
    const lab = await startLab(manifest())
    const harness = rig({
      lab,
      installs: [{ name: '@local/dsh-memory', version: '0.1.3', enabled: true }],
      managed: [{ name: '@local/dsh-memory', version: '0.1.3', source: 'bundled', enabled: true }],
    })
    const connector = harness.create(grantFor(lab))
    try {
      await connector.pullManifest()
      await vi.waitFor(() => { expect(lab.reports.length).toBeGreaterThan(0) })
      expect(lab.removals).toEqual([])
      expect(harness.state().managed).toEqual([
        { name: '@local/dsh-memory', version: '0.1.3', source: 'bundled', enabled: true },
      ])
      expect(lab.reports[0]?.plugins?.[0]).toMatchObject({ source: 'bundled', state: 'enabled' })
    } finally {
      await close(lab, harness.profile, connector)
    }
  })

  it('remembers an explicit uninstall so the next start does not restore the package', async () => {
    const lab = await startLab(manifest({ uninstall: ['@local/dsh-memory'] }))
    const bundled = join(mkdtempSync(join(tmpdir(), 'hub-bundled-set-')), 'hub-plugins')
    bundledDirectory(bundled, [{ package: '@local/dsh-memory', version: '0.1.3', level: 'default' }])
    const harness = rig({
      lab,
      bundled,
      installs: [{ name: '@local/dsh-memory', version: '0.1.3', enabled: true }],
      managed: [{ name: '@local/dsh-memory', version: '0.1.3', source: 'bundled', enabled: true }],
    })
    const first = harness.create(grantFor(lab))
    let restarted: HubConnector | undefined
    try {
      await first.pullManifest()
      await vi.waitFor(() => { expect(lab.removals).toEqual(['@local/dsh-memory']) })
      expect(harness.state().bundledRemovals).toEqual(['@local/dsh-memory'])
      expect(harness.state().managed).toEqual([])
      first.stop()
      // A restart with no account: the baseline must not put the package back.
      lab.installs.length = 0
      restarted = harness.create(undefined)
      await restarted.start()
      expect(lab.installs).toEqual([])
    } finally {
      await close(lab, harness.profile, restarted ?? first)
    }
  })
})

describe('the bundled model snapshot (design §4.3)', () => {
  it('renders the snapshot route and default until a manifest delivers its own', async () => {
    const lab = await startLab(manifest(), ['deepseek-v4.1-flash@relay'])
    const bundled = join(mkdtempSync(join(tmpdir(), 'hub-bundled-set-')), 'hub-plugins')
    bundledDirectory(bundled, [])
    modelSnapshot(bundled)
    const harness = rig({ lab, bundled })
    const connector = harness.create(grantFor(lab))
    try {
      await connector.start()
      // The route is the adapter's managed set, not an overlay row: a model row in the
      // overlay would outrank the profile patch the Models page writes.
      await vi.waitFor(() => {
        expect(JSON.stringify(harness.state().managedModels?.providers)).toContain('deepseek-v4.1-flash@relay')
      })
      const rendered = JSON.stringify(harness.state().managedModels?.providers)
      // The provider keeps its own configuration; only the device members are added.
      expect(rendered).toContain('"displayName":"DSH Hub","api":"openai-completions","reasoning":"max"')
      expect(rendered).toContain('"reasoningEfforts":{"low":"low","high":"high","max":"max"}')
      expect(rendered).toMatch(/"apiKeyEnv":"HUB_MK_HUB"/u)
      expect(harness.overlay()).not.toContain('llm-pi-ai')
      expect(lab.selections).toEqual([{ provider: 'hub-max', model: 'deepseek-v4.1-flash@relay', reasoningEffort: 'max' }])
      // The manifest that arrives next carries its own model fragments.
      lab.manifest = manifest({
        revision: 2,
        config: {
          fragments: [{
            id: 'llm-pi-ai', mode: 'enforce',
            config: { providers: { hub: { api: 'openai-completions', baseURL: 'https://hub.example/v1', models: [{ id: 'delivered-model', name: 'Delivered' }] } } },
          }],
        },
      })
      await connector.pullManifest()
      await vi.waitFor(() => {
        expect(JSON.stringify(harness.state().managedModels?.providers)).toContain('delivered-model')
      })
      expect(JSON.stringify(harness.state().managedModels?.providers)).not.toContain('deepseek-v4.1-flash@relay')
    } finally {
      await close(lab, harness.profile, connector)
    }
  })
})

describe('background dependency resolution in the Host (round 3)', () => {
  /** Install a bundled pilot whose dependency is missing, into the profile. */
  function installPilot(profile: string): void {
    const directory = join(profile, 'node_modules', '@local', 'dsh-claude-pilot')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name: '@local/dsh-claude-pilot',
      version: '0.6.0',
      dependencies: { '@anthropic-ai/claude-agent-sdk': '1.0.0' },
    }))
  }

  /** A directory for the stand-in package manager script. */
  function runnerRoot(): string {
    return mkdtempSync(join(tmpdir(), 'hub-bundled-runner-'))
  }

  /** A stand-in package manager that materialises the dependency and records the call. */
  function runner(root: string, exitCode = 0): { command: string; args: string[]; env: Record<string, string> } {
    const script = join(root, 'fake-pnpm.mjs')
    writeFileSync(script, [
      "import { mkdirSync, writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "writeFileSync(join(process.cwd(), 'pnpm-install.json'), JSON.stringify({ argv: process.argv.slice(2) }))",
      exitCode === 0
        ? "mkdirSync(join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), { recursive: true })"
        : 'process.exit(1)',
      'process.exit(0)',
      '',
    ].join('\n'))
    return { command: process.execPath, args: [script], env: { PATH: process.env.PATH ?? '' } }
  }

  const pilotRecord = { name: '@local/dsh-claude-pilot', version: '0.6.0', source: 'bundled' as const, enabled: true }

  it('installs in the background and activates the pilots with one reload', async () => {
    const lab = await startLab(manifest())
    const toggles: string[] = []
    const harness = rig({ lab, managed: [pilotRecord], toggles, packageManager: runner(runnerRoot()) })
    installPilot(harness.profile)
    const connector = harness.create(undefined)
    try {
      await connector.start()
      await vi.waitFor(() => { expect(toggles).toEqual(['@local/dsh-claude-pilot']) })
      const marker = JSON.parse(readFileSync(join(harness.profile, 'pnpm-install.json'), 'utf8')) as { argv: string[] }
      expect(marker.argv).toEqual(['install', '--prefer-offline'])
      expect(existsSync(join(harness.profile, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'))).toBe(true)
    } finally {
      await close(lab, harness.profile, connector)
    }
  })

  it('does not reload when the install fails, and does nothing on a resolved profile', async () => {
    const lab = await startLab(manifest())
    const toggles: string[] = []
    const harness = rig({ lab, managed: [pilotRecord], toggles, packageManager: runner(runnerRoot(), 1) })
    installPilot(harness.profile)
    const failing = harness.create(undefined)
    let second: HubConnector | undefined
    try {
      await failing.start()
      await vi.waitFor(() => { expect(existsSync(join(harness.profile, 'pnpm-install.json'))).toBe(true) })
      expect(toggles).toEqual([])
      failing.stop()
      // A second start sees a resolved profile: the install marker is not rewritten.
      mkdirSync(join(harness.profile, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), { recursive: true })
      rmSync(join(harness.profile, 'pnpm-install.json'), { force: true })
      second = harness.create(undefined)
      await second.start()
      await new Promise((resolve) => { setTimeout(resolve, 200) })
      expect(existsSync(join(harness.profile, 'pnpm-install.json'))).toBe(false)
      expect(toggles).toEqual([])
    } finally {
      await close(lab, harness.profile, second ?? failing)
    }
  })
})
