/**
 * One fake Hub, one desktop profile, and the connectors a test starts against them.
 *
 * The fixture serves the device report, an artifact, the relay model list, and a
 * manifest the test can replace between boots. Each `connect()` is one Host
 * process: it owns a boot id, and the plugin manager it sees is the same mutable
 * bundle list, so a case can hold a plugin installed across restarts.
 */
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vi } from 'vitest'
import { MemoryCredentials } from '../../../../packages/credentials/credentials/tests/memory.ts'
import { HubAccount, type HubGrant } from '../../hub/plugins/hub-connector/src/account.ts'
import { HubConnector, type ConnectorHost } from '../../hub/plugins/hub-connector/src/connector.ts'
import { emptyOverlay, writeOverlay } from '../../hub/plugins/hub-connector/src/overlay.ts'
import type { InstalledBundle } from '../../hub/plugins/hub-connector/src/manifest.ts'
import type { PiAiManagedProviderSlot } from '@deepseek-ai/dsh-llm-pi-ai'
import type { HubSessionTools } from '../../hub/plugins/hub-connector/src/search.ts'
import { initialState, loadState, saveState, type HubState } from '../../hub/plugins/hub-connector/src/state.ts'

/** Bytes the fake Hub serves as a plugin archive. */
export const TARBALL = Buffer.from('fixture-archive-bytes')
/** Digest the manifest declares for {@link TARBALL}. */
export const TARBALL_SHA256 = createHash('sha256').update(TARBALL).digest('hex')

/** One relay model route a first login receives. */
export const MODEL_FRAGMENT = {
  id: 'llm-pi-ai',
  mode: 'enforce',
  config: {
    providers: {
      hub: {
        displayName: 'DSH Hub',
        api: 'openai-completions',
        baseURL: 'http://relay.internal:7710/v1',
        apiKeyEnv: 'HUB_MK_HUB',
        models: [{ id: 'deepseek-v4.1-flash@relay', name: 'DeepSeek V4.1 Flash' }],
      },
    },
  },
}

/** The default selection the same delivery names. */
export const DEFAULT_FRAGMENT = {
  id: 'agent-default-model',
  mode: 'enforce',
  config: { provider: 'hub', model: 'deepseek-v4.1-flash@relay' },
}

/** The manifest a first login receives: a relay model route plus a default selection. */
export const MANIFEST = {
  schemaVersion: 1,
  revision: 4,
  issuedAt: '2026-10-23T00:00:00.000Z',
  plugins: [],
  uninstall: [],
  config: {
    fragments: [MODEL_FRAGMENT, DEFAULT_FRAGMENT],
  },
}

/** A composition row a delivery can change, which is what a restart prompt is for. */
export const COMPOSITION_FRAGMENT = {
  id: 'deepseek-account',
  mode: 'enforce',
  config: { credentialRef: 'HUB_ACCOUNT' },
}

/** The manifest shape whose delivery changes a composition row, so a restart is owed. */
export function manifestWithCompositionRow(): Record<string, unknown> {
  return { ...MANIFEST, config: { fragments: [...MANIFEST.config.fragments, COMPOSITION_FRAGMENT] } }
}

/** A fake Hub: the report endpoint, an artifact, and a manifest the test can replace. */
export async function startHub(
  build: (origin: string) => unknown = () => MANIFEST,
): Promise<{ server: Server; origin: string; serve(manifest: unknown): void; offline(value: boolean): void }> {
  let served: unknown = MANIFEST
  const offline = { value: false }
  const server = createServer((request, response) => {
    if (offline.value) {
      request.resume()
      response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":{"code":"UNAVAILABLE"}}')
      return
    }
    if (request.url === '/artifact.tgz') {
      response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': TARBALL.byteLength })
      response.end(TARBALL)
      return
    }
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/desktop/manifest') {
      const etag = `"revision-${String((served as { revision?: number }).revision ?? 0)}"`
      response.setHeader('etag', etag)
      // A conditional read of an unchanged manifest answers 304, as the Hub does.
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304).end()
        return
      }
      response.end(JSON.stringify(served))
      return
    }
    if (request.url === '/api/desktop/devices/report') {
      request.resume()
      response.end(JSON.stringify({ desiredRevision: null, reportIntervalSec: 900 }))
      return
    }
    if (request.url === '/v1/models') {
      request.resume()
      response.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash@relay', display_name: 'DeepSeek V4.1 Flash' }] }))
      return
    }
    response.writeHead(404).end('{}')
  })
  await new Promise<void>((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing server address')
  const origin = `http://127.0.0.1:${String(address.port)}`
  served = build(origin)
  return {
    server,
    origin,
    serve: (manifest) => { served = manifest },
    offline: (value: boolean) => { offline.value = value },
  }
}

/** One plugin entry whose metadata declares it needs a restart when it changes. */
export function restartingPlugin(origin: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '@fixture/needs-restart',
    version: '1.0.0',
    level: 'core',
    needsRestart: true,
    artifact: { url: `${origin}/artifact.tgz`, sha256: TARBALL_SHA256, bytes: TARBALL.byteLength },
    ...overrides,
  }
}

/** A recording stand-in for the adapter's managed-provider slot. */
export interface RecordingSlot {
  /** The slot a connector attaches. */
  readonly slot: PiAiManagedProviderSlot
  /** Every set the connector handed over, in order. */
  readonly sets: Record<string, unknown>[]
  /** How many times the connector withdrew the routes. */
  readonly withdrawals: number[]
  /** Whether the connector released the slot. */
  readonly released: { value: boolean }
}

/**
 * Build one recording slot, or fail the next replacement with `refusal`.
 * @param refusal - Message every replacement throws instead of committing.
 * @returns The slot and what it observed.
 */
export function recordingSlot(refusal?: string): RecordingSlot {
  const sets: Record<string, unknown>[] = []
  const withdrawals: number[] = []
  const released = { value: false }
  let count = 0
  return {
    sets,
    withdrawals,
    released,
    slot: {
      source: 'hub',
      replace: (providers) => {
        if (refusal !== undefined) throw new Error(refusal)
        sets.push(providers)
      },
      withdraw: () => { count += 1; withdrawals.push(count) },
      release: () => {
        released.value = true
        count += 1
        withdrawals.push(count)
      },
    },
  }
}

/** Options one fixture run accepts. */
export interface FixtureOptions {
  /** Build the manifest once the fake Hub knows its own origin. */
  readonly manifest?: ((origin: string) => unknown) | undefined
  /** Bundles the fake plugin manager reports as installed. */
  readonly installed?: InstalledBundle[] | undefined
  /** Whether the profile already has a default model selection. */
  readonly hasDefaultModel?: boolean | undefined
  /** Search-pool state the cached grant carries. */
  readonly grantTools?: HubSessionTools | undefined
  /** Device id the stored grant names; a different one simulates another account/device. */
  readonly grantDeviceId?: string | undefined
}

/** One desktop profile, its Hub, and the fallback state a new connector starts from. */
export interface Fixture {
  readonly profile: string
  readonly origin: string
  readonly fallback: HubState
  readonly server: Server
  /** Manager calls observed so far; a replay that changed nothing must leave it empty. */
  readonly calls: string[]
  /** Default-model selections the connector asked the Host to save. */
  readonly selections: { provider: string; model: string; reasoningEffort?: string }[]
  /** Whether the profile currently has a default selection; true after the first save. */
  readonly selected: { value: boolean }
  /** Construct a connector for this profile as one Host process. */
  connect(bootId: string): HubConnector
  /** Read what the profile now holds. */
  read(): HubState
  /** Replace the manifest this Hub serves. */
  serve(manifest: unknown): void
  /** Make every Hub endpoint answer 503, as an unreachable Hub does. */
  offline(value: boolean): void
}

/** Build one profile and Hub, cleaned up whether or not the body throws. */
export async function withFixture(body: (fixture: Fixture) => Promise<void>, options: FixtureOptions = {}): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'hub-restart-notice-'))
  const hub = await startHub(options.manifest)
  const fallback = initialState({ osLabel: 'Windows 11', hubOrigin: hub.origin, installId: 'install-1' })
  saveState(profile, { ...fallback, deviceId: 'dv_0123456789abcdef0123456789abcdef' })
  // The shell seeds the overlay before the Host starts (design §4.2), so the first
  // delivered fragment always changes an existing file.
  writeOverlay(profile, emptyOverlay(true))
  const connectors: HubConnector[] = []
  const context = new Context()
  const credentials = new MemoryCredentials(context)
  const calls: string[] = []
  const selections: { provider: string; model: string; reasoningEffort?: string }[] = []
  const selected = { value: options.hasDefaultModel ?? false }
  let installed: InstalledBundle[] = [...options.installed ?? []]
  const build = {
    appVersion: '0.2.1-rc.2', appChannel: 'latest', runtimeVersion: '0.2.1-rc.2',
    builtHubOrigin: hub.origin, osLabel: 'Windows 11', installId: 'install-1',
    schemaDirectory: resolve(import.meta.dirname, '../../hub/plugins/hub-connector'),
  } as const
  const clock = { at: new Date('2026-10-23T01:00:00.000Z') }
  const host = (bootId: string): ConnectorHost => ({
    profile, build, environment: {}, bootId,
    account: {
      build, environment: {}, credentials, registerRoute: () => () => undefined,
      hubOrigin: () => hub.origin, readState: () => loadState(profile, fallback), writeState: (state) => { saveState(profile, state) },
      emit: () => undefined, changed: () => undefined, now: () => new Date(clock.at), random: size => Buffer.alloc(size),
    },
    hasDefaultModel: async () => selected.value,
    selectDefaultModel: async (selection) => {
      selections.push({ ...selection })
      selected.value = true
    },
    pluginManager: {
      listBundles: async () => installed,
      installBundle: async (spec) => {
        calls.push(`install:${spec}`)
        installed = [...installed, { name: '@fixture/needs-restart', version: '1.0.0', enabled: true, removable: true }]
        return { changed: true }
      },
      removeBundle: async (name) => { calls.push(`remove:${name}`); installed = installed.filter(bundle => bundle.name !== name); return { changed: true } },
      setBundleEnabled: async (name, enabled) => {
        calls.push(`toggle:${name}:${String(enabled)}`)
        installed = installed.map(bundle => (bundle.name === name ? { ...bundle, enabled } : bundle))
        return { changed: true }
      },
    },
  })
  const grant: HubGrant = {
    version: 1, token: 'test-device-token', hubOrigin: hub.origin,
    deviceId: options.grantDeviceId ?? 'dv_0123456789abcdef0123456789abcdef',
    expiresAt: '2026-11-01T00:00:00Z', absoluteExpiresAt: '2026-12-01T00:00:00Z',
    user: { username: 'test', displayName: 'Test', role: 'user', roleLabel: '' }, wallet: null,
    ...options.grantTools === undefined ? {} : { tools: options.grantTools },
  }
  try {
    await body({
      profile, origin: hub.origin, fallback, server: hub.server, calls, selections, selected,
      connect(bootId) {
        const connector = new HubConnector(host(bootId), (accountHost) => {
          const account = new HubAccount(accountHost)
          vi.spyOn(account, 'readGrant').mockResolvedValue(grant)
          return account
        })
        connectors.push(connector)
        return connector
      },
      read: () => loadState(profile, fallback),
      serve: (manifest) => { hub.serve(manifest) },
      offline: (value) => { hub.offline(value) },
    })
  } finally {
    for (const connector of connectors) connector.stop()
    hub.server.closeAllConnections()
    await new Promise<void>((resolveClose, reject) => { hub.server.close((error) => { if (error) reject(error); else resolveClose() }) })
    rmSync(profile, { recursive: true, force: true })
  }
}
