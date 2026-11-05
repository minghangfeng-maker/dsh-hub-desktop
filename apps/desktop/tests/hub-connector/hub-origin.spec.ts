/**
 * The Hub address: what the build carries, what the user may override, and what a
 * change does to the account that belongs to the old Hub.
 *
 * The Hub is a recording `fetch` here. Every request the connector could make is
 * visible, which is what the "no old token reaches the new origin" invariant needs;
 * a real loopback server would hide the authorization header the test is about.
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { MemoryCredentials } from '../../../../packages/credentials/credentials/tests/memory.ts'
import {
  HUB_AGENT_MODE_REFS,
  HUB_RELAY_REF,
  HUB_TOKEN_KEY,
  HubAccount,
  type HubGrant,
} from '../../hub/plugins/hub-connector/src/account.ts'
import {
  HubConnector,
  HubOriginChangeError,
  type ConnectorHost,
} from '../../hub/plugins/hub-connector/src/connector.ts'
import { readBuildHubOrigin, type BuildIdentity } from '../../hub/plugins/hub-connector/src/device.ts'
import { registerClientRoutes } from '../../hub/plugins/hub-connector/src/routes.ts'
import { HUB_STATE_DIRECTORY, initialState, loadState, saveState, statePath, type HubState } from '../../hub/plugins/hub-connector/src/state.ts'

/** Origin the build carries in every case unless the case says otherwise. */
const BUILT = 'https://hub.example.com'

/** Another Hub the user can point this install at. */
const OTHER = 'https://other.example.com'

/** Token the seeded grant carries; no request to the new origin may ever show it. */
const OLD_TOKEN = 'dsh_dev_old'

/** Account facts the fake Hub answers with. */
const USER = { username: 'alice', displayName: 'Alice', role: 'admin' as const, roleLabel: 'Admin' }

/** One request the connector made through `fetch`. */
interface HubCall {
  readonly origin: string
  readonly path: string
  readonly method: string
  readonly authorization: string | undefined
}

/** A recording stand-in for the Hub endpoints the connector reaches. */
interface HubLab {
  /** Every request, in order. */
  readonly calls: HubCall[]
  /** Origins that accept the connection and never answer. */
  readonly hanging: Set<string>
}

/** Directories every case removes afterwards. */
const created: string[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Build one JSON response the way `hubRequest` reads it. */
function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as Response
}

/** Answer one connector request as the Hub this case describes. */
function hubAnswer(origin: string, path: string): Response {
  if (path === '/api/desktop/auth/start') {
    return jsonResponse(200, {
      requestId: 'req-1',
      authorizeUrl: `${origin}/desktop/authorize?req=req-1`,
      expiresAt: '2027-01-01T00:00:00.000Z',
    })
  }
  if (path === '/api/desktop/auth/token') {
    return jsonResponse(200, {
      token: 'dsh_dev_new',
      expiresAt: '2027-01-01T00:00:00.000Z',
      absoluteExpiresAt: '2027-03-01T00:00:00.000Z',
      user: USER,
      wallet: null,
      device: { deviceId: 'dv_new', name: 'WS' },
      relay: null,
    })
  }
  if (path === '/api/desktop/auth/logout') return jsonResponse(200, { revoked: 1 })
  if (path === '/api/desktop/session') {
    return jsonResponse(200, {
      user: USER,
      wallet: null,
      device: { deviceId: 'dv_old', name: 'WS' },
      tools: { search: false, baseUrl: null },
    })
  }
  if (path === '/api/desktop/devices/report') {
    return jsonResponse(200, {
      serverTime: '2027-01-01T00:00:00.000Z',
      reportIntervalSec: 900,
      presence: 'online',
      desiredRevision: null,
    })
  }
  if (path === '/v1/models') return jsonResponse(200, { data: [] })
  return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'no such route' } })
}

/** Install the recording Hub as `globalThis.fetch`. */
function startLab(): HubLab {
  const lab: HubLab = { calls: [], hanging: new Set<string>() }
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    lab.calls.push({
      origin: url.origin,
      path: url.pathname,
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization') ?? undefined,
    })
    if (lab.hanging.has(url.origin)) {
      // A Hub that accepts the connection and never answers: only the client's own
      // timeout can end this request.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
    }
    return hubAnswer(url.origin, url.pathname)
  })
  return lab
}

/** Everything one connector case needs. */
interface Rig {
  readonly profile: string
  readonly connector: HubConnector
  readonly credentials: MemoryCredentials
  readonly lab: HubLab
  /** Build identity the connector reports. */
  readonly build: BuildIdentity
  /** Events the Host composition would have received. */
  readonly events: string[]
  /** Read the state file as a fresh process would. */
  state(): HubState
  /** Web routes the connector registered, by path. */
  readonly routes: Map<string, (request: IncomingMessage, response: ServerResponse) => void>
}

/** Options one case can seed the profile with. */
interface RigOptions {
  /** Origin the build carries; {@link BUILT} by default. */
  readonly builtOrigin?: string
  /** Value the profile's settings hold; '' by default. */
  readonly override?: string
  /** Whether the profile holds a grant issued by {@link BUILT}. */
  readonly signedIn?: boolean
  /** Whether the profile is written with the pre-rename `settings.hubOrigin` key. */
  readonly legacyKey?: boolean
  /** Origin that pre-rename key holds; the build's own origin by default. */
  readonly legacyOrigin?: string
}

/**
 * Build one profile, its recording Hub, and a connector over them.
 * @param options - Origin, stored override, and account state the case starts from.
 * @returns The connector and what it observed.
 */
async function rig(options: RigOptions = {}): Promise<Rig> {
  const profile = mkdtempSync(join(tmpdir(), 'hub-origin-'))
  created.push(profile)
  const builtOrigin = options.builtOrigin ?? BUILT
  const lab = startLab()
  const context = new Context()
  const credentials = new MemoryCredentials(context)
  const events: string[] = []
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => void>()
  const build: BuildIdentity = {
    appVersion: '0.2.3', appChannel: 'latest', runtimeVersion: '0.2.3',
    builtHubOrigin: builtOrigin, osLabel: 'Windows 11', installId: 'install-1',
    schemaDirectory: resolve(import.meta.dirname, '../../hub/plugins/hub-connector'),
  }
  const fallback = initialState({ osLabel: build.osLabel, installId: build.installId })
  saveState(profile, {
    ...fallback,
    deviceId: 'dv_old',
    settings: { ...fallback.settings, hubOriginOverride: options.override ?? '' },
  })
  if (options.legacyKey === true) {
    // The document an earlier build wrote: the build origin sits in `settings.hubOrigin`.
    const document = JSON.parse(readFileSync(statePath(profile), 'utf8')) as { settings: Record<string, unknown> }
    delete document.settings.hubOriginOverride
    document.settings.hubOrigin = options.legacyOrigin ?? builtOrigin
    writeFileSync(statePath(profile), JSON.stringify(document))
  }
  const webServer: Pick<WebServer, 'register'> = {
    register: (route) => {
      routes.set(route.path, (request, response) => { void route.handler(request, response) })
      return () => { routes.delete(route.path) }
    },
  }
  context.provide('webServer', webServer as WebServer)
  const connection: Pick<HostConnectionHandle, 'authorizeIndex'> = { authorizeIndex: () => true }
  context.provide('connection', connection as HostConnectionHandle)
  const host: ConnectorHost = {
    profile,
    build,
    environment: {},
    account: {
      build,
      environment: {},
      credentials,
      registerRoute: () => () => undefined,
      hubOrigin: () => builtOrigin,
      readState: () => loadState(profile, fallback),
      writeState: (next) => { saveState(profile, next) },
      emit: (event) => { events.push(event) },
      changed: () => undefined,
      now: () => new Date(),
      random: size => Buffer.alloc(size),
    },
  }
  const connector = new HubConnector(host, accountHost => new HubAccount(accountHost))
  registerClientRoutes(context, connector)
  if (options.signedIn === true) await seedGrant(credentials, builtOrigin)
  return {
    profile, connector, credentials, lab, build, events, routes,
    state: () => loadState(profile, fallback),
  }
}

/**
 * Store one grant issued by `origin`, plus the credentials that belong to it.
 * @param credentials - Credential seam to seed.
 * @param origin - Hub that issued the grant.
 * @returns after every credential is stored.
 */
async function seedGrant(credentials: MemoryCredentials, origin: string): Promise<void> {
  const grant: HubGrant = {
    version: 1,
    token: OLD_TOKEN,
    hubOrigin: origin,
    deviceId: 'dv_old',
    expiresAt: '2027-01-01T00:00:00.000Z',
    absoluteExpiresAt: '2027-03-01T00:00:00.000Z',
    user: USER,
    wallet: null,
  }
  await credentials.modifyRecord(HUB_TOKEN_KEY, () => Promise.resolve({ kind: 'grant', payload: grant }))
  await credentials.set(HUB_RELAY_REF, 'relay-secret')
  for (const ref of Object.values(HUB_AGENT_MODE_REFS)) await credentials.set(ref, `${ref}-secret`)
}

/** One answer a route wrote. */
interface RouteAnswer {
  readonly status: number
  readonly body: unknown
}

/**
 * Call one route the way the Host webserver does.
 * @param route - Registered route handler.
 * @param body - JSON body the request carries.
 * @returns The status and JSON body the handler wrote.
 */
async function callRoute(route: (request: IncomingMessage, response: ServerResponse) => void, body: unknown): Promise<RouteAnswer> {
  const answer = Promise.withResolvers<RouteAnswer>()
  const request = {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
  let status = 0
  const response = {
    headersSent: false,
    writeHead(next: number, _headers?: Record<string, string>) {
      status = next
      response.headersSent = true
      return response
    },
    end(text?: string) {
      answer.resolve({ status, body: text === undefined || text === '' ? undefined : JSON.parse(text) as unknown })
    },
  }
  route(request as IncomingMessage, response as ServerResponse)
  return await answer.promise
}

describe('the stored Hub address', () => {
  it('starts with no build-time origin and ignores the pre-rename settings key', () => {
    const fresh = initialState({ osLabel: 'Windows 11', installId: 'install-1' })
    expect(fresh.settings).toEqual({ hubOriginOverride: '', deviceName: 'Windows 11 上的 DSH Hub', deepSeekLogin: false })
    const profile = mkdtempSync(join(tmpdir(), 'hub-origin-state-'))
    created.push(profile)
    mkdirSync(join(profile, HUB_STATE_DIRECTORY), { recursive: true })
    writeFileSync(statePath(profile), JSON.stringify({
      schemaVersion: 1,
      deviceId: 'dv_old',
      installId: 'install-1',
      settings: { hubOrigin: BUILT, deviceName: 'Office PC', deepSeekLogin: true },
      managed: [{ name: '@scope/plugin', version: '1.0.0', source: 'hub-core', enabled: true }],
    }))
    const loaded = loadState(profile, fresh)
    // The old key held the origin of the build that wrote it, which no user could
    // edit; adopting it would pin this install to that Hub across upgrades.
    expect(loaded.settings).toEqual({ hubOriginOverride: '', deviceName: 'Office PC', deepSeekLogin: true })
    expect(loaded.deviceId).toBe('dv_old')
    expect(loaded.managed).toEqual([{ name: '@scope/plugin', version: '1.0.0', source: 'hub-core', enabled: true }])
    saveState(profile, loaded)
    expect(readFileSync(statePath(profile), 'utf8')).not.toContain('"hubOrigin"')
  })

  it('follows a newly installed build after an upgrade instead of the old address', async () => {
    // The installed state still names the Hub the previous build baked in.
    const state = await rig({ builtOrigin: BUILT, legacyKey: true, legacyOrigin: OTHER })
    try {
      expect(state.connector.origin()).toBe(BUILT)
      const status = await state.connector.status()
      expect(status).toMatchObject({ hubOrigin: BUILT, hubOriginOverride: '', builtHubOrigin: BUILT })
    } finally {
      state.connector.stop()
    }
  })

  it('prefers the user override, then the environment, then build-info.json', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hub-build-info-'))
    created.push(directory)
    writeFileSync(join(directory, 'build-info.json'), JSON.stringify({ schemaVersion: 1, channel: 'latest', hubOrigin: BUILT }))
    expect(readBuildHubOrigin(directory, {})).toBe(BUILT)
    expect(readBuildHubOrigin(directory, { DSH_HUB_ORIGIN: OTHER })).toBe(OTHER)
    expect(readBuildHubOrigin(join(directory, 'missing'), { DSH_HUB_ORIGIN: '' })).toBe('')
    expect(readBuildHubOrigin(join(directory, 'missing'), { DSH_HUB_ORIGIN: ` ${OTHER} ` })).toBe(OTHER)
    const state = await rig({ builtOrigin: OTHER, override: BUILT })
    try {
      expect(state.connector.origin()).toBe(BUILT)
    } finally {
      state.connector.stop()
    }
  })
})

describe('changing the Hub address', () => {
  it('refuses an address the transport rules reject without touching the account', async () => {
    const state = await rig({ signedIn: true })
    try {
      const before = state.state()
      for (const value of ['http://hub.example.com', 'not an origin', 'https://hub.example.com/?token=1']) {
        await expect(state.connector.changeHubOrigin(value)).rejects.toMatchObject({ code: 'invalid-origin' })
      }
      expect(state.state()).toEqual(before)
      expect(await state.connector.status()).toMatchObject({ signedIn: true, hubOrigin: BUILT })
      expect(await state.credentials.readRecord(HUB_TOKEN_KEY)).toBeDefined()
      expect(state.lab.calls.filter(call => call.path === '/api/desktop/auth/logout')).toEqual([])
    } finally {
      state.connector.stop()
    }
  })

  it('stores an address equal to the build one as "follow the build" and stays signed in', async () => {
    const state = await rig({ signedIn: true, override: BUILT })
    try {
      expect(await state.connector.status()).toMatchObject({ signedIn: true, hubOrigin: BUILT, hubOriginOverride: BUILT })
      await state.connector.changeHubOrigin(BUILT)
      expect(state.state().settings.hubOriginOverride).toBe('')
      expect(await state.connector.status()).toMatchObject({ signedIn: true, hubOrigin: BUILT, hubOriginOverride: '' })
      expect(state.lab.calls.filter(call => call.path === '/api/desktop/auth/logout')).toEqual([])
      expect(await state.credentials.readRecord(HUB_TOKEN_KEY)).toBeDefined()
    } finally {
      state.connector.stop()
    }
  })

  it('refuses to move the address while a sign-in is still bound to the current origin', async () => {
    const state = await rig()
    try {
      await state.connector.startLogin('http://127.0.0.1:1234')
      const attempt = (await state.connector.account.getState()).attempt
      expect(attempt?.phase).toBe('waiting-browser')
      await expect(state.connector.changeHubOrigin(OTHER)).rejects.toBeInstanceOf(HubOriginChangeError)
      await expect(state.connector.changeHubOrigin(OTHER)).rejects.toMatchObject({ code: 'sign-in-in-progress' })
      expect(state.state().settings.hubOriginOverride).toBe('')
      expect((await state.connector.account.getState()).attempt?.phase).toBe('waiting-browser')
      if (attempt !== null && attempt !== undefined) await state.connector.account.cancelSignIn(attempt.id)
    } finally {
      state.connector.stop()
    }
  })

  it('signs out of the old Hub, then stores the new address', async () => {
    const state = await rig({ signedIn: true })
    try {
      expect(await state.connector.status()).toMatchObject({ signedIn: true, hubOrigin: BUILT })
      await state.connector.changeHubOrigin(OTHER)
      expect(state.state().settings.hubOriginOverride).toBe(OTHER)
      expect(await state.connector.status()).toMatchObject({
        signedIn: false, hubOrigin: OTHER, hubOriginOverride: OTHER, builtHubOrigin: BUILT,
      })
      // The grant, the relay key, and the pilot keys belonged to the old Hub.
      expect(await state.credentials.readRecord(HUB_TOKEN_KEY)).toBeUndefined()
      expect(await state.credentials.resolve(HUB_RELAY_REF)).toBeUndefined()
      for (const ref of Object.values(HUB_AGENT_MODE_REFS)) expect(await state.credentials.resolve(ref)).toBeUndefined()
      // Revocation reached the issuing Hub with the device token it issued…
      expect(state.lab.calls.filter(call => call.path === '/api/desktop/auth/logout')).toEqual([
        { origin: BUILT, path: '/api/desktop/auth/logout', method: 'POST', authorization: `Bearer ${OLD_TOKEN}` },
      ])
      // …and the sign-out is what tells the composition to close phone access.
      expect(state.events).toContain('hub-connector/signed-out')
      expect(state.events).toContain('deepseek-account/signed-out')
    } finally {
      state.connector.stop()
    }
  })

  it('never sends the old Hub token to the new address', async () => {
    const state = await rig({ signedIn: true })
    try {
      await state.connector.changeHubOrigin(OTHER)
      const switched = state.lab.calls.length
      // Everything the connector could do next: sign in again, report, and refresh.
      await state.connector.startLogin('http://127.0.0.1:1234')
      await state.connector.report()
      await state.connector.refreshSession()
      const attempt = (await state.connector.account.getState()).attempt
      const after = state.lab.calls.slice(switched)
      expect(after.length).toBeGreaterThan(0)
      expect(after.filter(call => call.origin === OTHER && call.authorization !== undefined)).toEqual([])
      expect(after.filter(call => call.authorization === `Bearer ${OLD_TOKEN}`)).toEqual([])
      // The sign-in that follows a switch goes to the new address.
      expect(after.filter(call => call.path === '/api/desktop/auth/start').map(call => call.origin)).toEqual([OTHER])
      expect(state.lab.calls.filter(call => call.authorization === `Bearer ${OLD_TOKEN}`)
        .every(call => call.origin === BUILT)).toBe(true)
      if (attempt !== null && attempt !== undefined) await state.connector.account.cancelSignIn(attempt.id)
    } finally {
      state.connector.stop()
    }
  })

  it('finishes the switch when the old Hub never answers', async () => {
    const state = await rig({ signedIn: true })
    state.lab.hanging.add(BUILT)
    try {
      vi.useFakeTimers()
      const switching = state.connector.changeHubOrigin(OTHER)
      // The revoke request is bounded; the switch does not wait for a Hub the user left.
      await vi.advanceTimersByTimeAsync(5000)
      await switching
      expect(state.state().settings.hubOriginOverride).toBe(OTHER)
      expect(await state.connector.status()).toMatchObject({ signedIn: false, hubOrigin: OTHER })
      expect(state.lab.calls.filter(call => call.path === '/api/desktop/auth/logout')).toHaveLength(1)
    } finally {
      state.connector.stop()
    }
  })
})

describe('the settings route', () => {
  it('answers 400 with the normalized reason for an address it refuses', async () => {
    const state = await rig({ signedIn: true })
    try {
      const route = state.routes.get('/hub-connector/api/settings')
      if (route === undefined) throw new Error('the settings route was not registered')
      const answer = await callRoute(route, { hubOrigin: 'http://hub.example.com' })
      expect(answer.status).toBe(400)
      expect(answer.body).toMatchObject({ error: 'invalid-origin' })
      expect((answer.body as { message: string }).message).toContain('HTTPS')
      expect(state.state().settings.hubOriginOverride).toBe('')
      expect(await state.connector.status()).toMatchObject({ signedIn: true, hubOrigin: BUILT })
    } finally {
      state.connector.stop()
    }
  })

  it('answers 409 while a sign-in is in flight', async () => {
    const state = await rig()
    try {
      const route = state.routes.get('/hub-connector/api/settings')
      if (route === undefined) throw new Error('the settings route was not registered')
      await state.connector.startLogin('http://127.0.0.1:1234')
      const answer = await callRoute(route, { hubOrigin: OTHER })
      expect(answer).toEqual({ status: 409, body: { error: 'sign-in-in-progress' } })
      expect(state.state().settings.hubOriginOverride).toBe('')
      const attempt = (await state.connector.account.getState()).attempt
      if (attempt !== null && attempt !== undefined) await state.connector.account.cancelSignIn(attempt.id)
    } finally {
      state.connector.stop()
    }
  })

  it('restores the build-time origin from an empty address', async () => {
    const state = await rig()
    try {
      const route = state.routes.get('/hub-connector/api/settings')
      if (route === undefined) throw new Error('the settings route was not registered')
      await state.connector.changeHubOrigin(OTHER)
      expect(state.state().settings.hubOriginOverride).toBe(OTHER)
      const answer = await callRoute(route, { hubOrigin: '' })
      expect(answer.status).toBe(200)
      expect(answer.body).toMatchObject({ hubOrigin: BUILT, hubOriginOverride: '', builtHubOrigin: BUILT })
      expect(state.state().settings.hubOriginOverride).toBe('')
    } finally {
      state.connector.stop()
    }
  })

  it('applies nothing when a request carries a refused address next to another field', async () => {
    const state = await rig()
    try {
      const route = state.routes.get('/hub-connector/api/settings')
      if (route === undefined) throw new Error('the settings route was not registered')
      const before = state.state()
      const refused = await callRoute(route, { hubOrigin: 'http://hub.example.com', deviceName: 'renamed' })
      expect(refused.status).toBe(400)
      expect(state.state()).toEqual(before)
      const accepted = await callRoute(route, { hubOrigin: OTHER, deviceName: 'renamed' })
      expect(accepted.status).toBe(200)
      expect(accepted.body).toMatchObject({ hubOrigin: OTHER, hubOriginOverride: OTHER, deviceName: 'renamed' })
      expect(state.state()).toMatchObject({ settings: { hubOriginOverride: OTHER, deviceName: 'renamed' } })
    } finally {
      state.connector.stop()
    }
  })
})
