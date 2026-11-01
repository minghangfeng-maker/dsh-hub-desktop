/**
 * The account provider's contract: PKCE material, the browser login state
 * machine, token rotation, and what a revocation does to local state.
 *
 * The Hub is a real loopback HTTP server here, because the provider's whole job
 * is that conversation: a stubbed fetch would not prove the redirect, the state
 * comparison, or the credential write.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HUB_CALLBACK_PATH,
  HUB_RELAY_REF,
  HUB_TOKEN_KEY,
  HubAccount,
  codeChallenge,
  parseGrant,
  pointsText,
  roleText,
  sameSecret,
} from '../../hub/plugins/hub-connector/src/account.ts'
import type { AccountHost } from '../../hub/plugins/hub-connector/src/account.ts'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'

/** One recorded Hub request. */
interface Recorded {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
  readonly body: unknown
}

/** A fake Hub that answers the five endpoints the login path uses. */
class FakeHub {
  readonly requests: Recorded[] = []
  /** Status the token endpoint answers with, or 200. */
  tokenStatus = 200
  /** Body the token endpoint answers with. */
  tokenBody: Record<string, unknown> = {}
  /** Whether the session endpoint answers 401. */
  sessionUnauthorized = false
  /** `tools` member the session endpoint reports; undefined = an older Hub. */
  sessionTools: Record<string, unknown> | undefined
  private server: Server | undefined
  private pending = new Map<string, { code: string; state: string }>()

  get origin(): string {
    const address = this.server?.address()
    if (address === null || address === undefined) throw new Error('fake hub is not listening')
    return `http://127.0.0.1:${String((address as AddressInfo).port)}`
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => { void this.handle(request, response) })
    await new Promise<void>((resolve) => { this.server?.listen(0, '127.0.0.1', resolve) })
  }

  async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    // Undici keeps sockets alive; closing only the listener would leave the hook pending.
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  }

  /** Approve the pending request the way the browser page would. */
  approve(): { readonly redirect: string } {
    const entry = [...this.pending.entries()][0]
    if (entry === undefined) throw new Error('no pending request')
    return { redirect: entry[1].state }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
    const text = Buffer.concat(chunks).toString('utf8')
    const body: unknown = text === '' ? undefined : JSON.parse(text) as unknown
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    this.requests.push({
      method: request.method ?? 'GET',
      path,
      authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
      body,
    })
    const answer = (status: number, value: unknown): void => {
      const payload = JSON.stringify(value)
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
      response.end(payload)
    }
    if (path === '/api/desktop/auth/start') {
      const start = body as { state: string; redirectUri: string }
      this.pending.set('req-1', { code: 'code-1', state: start.state })
      answer(200, { requestId: 'req-1', authorizeUrl: `${this.origin}/desktop/authorize?req=req-1`, expiresAt: new Date(Date.now() + 600_000).toISOString() })
      return
    }
    if (path === '/api/desktop/auth/token') {
      answer(this.tokenStatus, this.tokenBody)
      return
    }
    if (path === '/api/desktop/session') {
      if (this.sessionUnauthorized) {
        answer(401, { error: { code: 'DEVICE_TOKEN_INVALID', message: '登录已失效' } })
        return
      }
      answer(200, {
        user: { username: 'alice', displayName: 'Alice', role: 'admin', roleLabel: '' },
        wallet: { balance: 1_234_500_000, unit: 'micro-point' },
        device: { deviceId: 'dv_0123456789abcdef0123456789abcdef', name: 'WS' },
        ...this.sessionTools === undefined ? {} : { tools: this.sessionTools },
      })
      return
    }
    if (path === '/api/desktop/auth/refresh') {
      answer(200, { token: 'dsh_dev_refreshed', expiresAt: new Date(Date.now() + 2_592_000_000).toISOString(), absoluteExpiresAt: new Date(Date.now() + 7_776_000_000).toISOString() })
      return
    }
    if (path === '/api/desktop/auth/logout') {
      answer(200, { revoked: 1 })
      return
    }
    answer(404, { error: { code: 'NOT_FOUND', message: 'not found' } })
  }
}

/** In-memory credential seam. */
class MemoryCredentials {
  readonly records = new Map<string, CredentialRecord>()
  readonly refs = new Map<string, string>()

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.records.get(key)
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (next !== undefined) this.records.set(key, next)
    return next
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
  }

  async set(ref: string, value: string): Promise<void> {
    this.refs.set(ref, value)
  }

  async unset(ref: string): Promise<void> {
    this.refs.delete(ref)
  }

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    const value = this.refs.get(ref)
    return value === undefined ? undefined : { value, source: 'managed' }
  }
}

/** Build one account host over the fakes. */
function hostFor(hub: FakeHub, credentials: MemoryCredentials): {
  host: AccountHost
  events: string[]
  /** Every search state the provider reported, oldest first. */
  toolsCalls: { search: boolean; baseUrl: string | null }[]
  route: { path: string; handler: ((request: IncomingMessage, response: never) => void) | undefined }
} {
  const events: string[] = []
  const toolsCalls: { search: boolean; baseUrl: string | null }[] = []
  const route: { path: string; handler: ((request: IncomingMessage, response: never) => void) | undefined } = { path: '', handler: undefined }
  const host: AccountHost = {
    build: {
      appVersion: '0.2.2',
      appChannel: 'latest',
      runtimeVersion: '0.2.2',
      builtHubOrigin: hub.origin,
      osLabel: 'Windows 11',
      installId: '0f0e0d0c-0b0a-4908-8706-050403020100',
      schemaDirectory: '.',
    },
    environment: { PATH: '' },
    credentials: credentials as unknown as CredentialProvider,
    registerRoute: (path, handler) => {
      route.path = path
      route.handler = handler
      return () => { route.path = '' }
    },
    hubOrigin: () => hub.origin,
    readState: () => ({
      schemaVersion: 1,
      deviceId: null,
      installId: '0f0e0d0c-0b0a-4908-8706-050403020100',
      settings: { hubOrigin: hub.origin, deviceName: 'WS', deepSeekLogin: false },
      managed: [],
      managedModels: null,
      pendingRemovals: [],
      bundledRemovals: [],
      applySequence: 0,
      syncedAt: null,
      manifestEtag: null,
      configDigest: null,
      appliedRevision: null,
      appliedAt: null,
      applyState: 'unknown',
      applyErrorCode: null,
      errorCount: 0,
      lastReport: null,
      restart: null,
    }),
    writeState: () => undefined,
    emit: (event) => { events.push(event) },
    sessionTools: (tools) => { toolsCalls.push(tools) },
    changed: () => undefined,
    now: () => new Date(),
    random: size => Buffer.alloc(size, 7),
  }
  return { host, events, toolsCalls, route }
}

import type { ServerResponse } from 'node:http'

/** Poll an account snapshot until the attempt reaches one phase (the login runs in the background). */
async function waitForPhase(account: HubAccount, phase: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if ((await account.getState()).attempt?.phase === phase) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`attempt never reached ${phase}`)
}

describe('PKCE and token helpers', () => {
  it('derives the base64url S256 challenge the Hub accepts', () => {
    const challenge = codeChallenge('a'.repeat(43))
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(codeChallenge('a'.repeat(43))).toBe(challenge)
    expect(codeChallenge('b'.repeat(43))).not.toBe(challenge)
  })

  it('compares states without leaking length through early exit', () => {
    expect(sameSecret('abc', 'abc')).toBe(true)
    expect(sameSecret('abc', 'abd')).toBe(false)
    expect(sameSecret('abc', 'abcd')).toBe(false)
  })

  it('formats micro-points and the role label the account row shows', () => {
    expect(pointsText(1_234_500_000)).toBe('1234.50')
    expect(pointsText(0)).toBe('0.00')
    expect(roleText({ username: 'a', displayName: 'A', role: 'admin', roleLabel: '' })).toBe('管理员')
    expect(roleText({ username: 'a', displayName: 'A', role: 'user', roleLabel: '研究组' })).toBe('研究组')
    expect(roleText({ username: 'a', displayName: 'A', role: 'user', roleLabel: ' ' })).toBe('普通用户')
  })

  it('rejects a stored grant that is not one this build wrote', () => {
    expect(parseGrant({ version: 2 })).toBeUndefined()
    expect(parseGrant({ version: 1, token: 't' })).toBeUndefined()
  })
})

describe('browser login', () => {
  let hub: FakeHub

  beforeEach(async () => {
    hub = new FakeHub()
    await hub.start()
  })

  afterEach(async () => {
    await hub.stop()
  })

  it('runs start → browser callback → exchange and stores the device grant', async () => {
    hub.tokenBody = {
      token: 'dsh_dev_abc',
      expiresAt: new Date(Date.now() + 2_592_000_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 7_776_000_000).toISOString(),
      user: { username: 'alice', displayName: 'Alice', role: 'admin', roleLabel: '' },
      wallet: { balance: 1_234_500_000, unit: 'micro-point' },
      device: { deviceId: 'dv_0123456789abcdef0123456789abcdef', name: 'WS', createdAt: new Date().toISOString() },
      relay: { keyId: 3, secret: 'sk-dsh-abc', ref: 'HUB_MK_HUB', baseUrl: `${hub.origin}/v1`, scope: 'dsh' },
      hub: { publicBaseUrl: hub.origin },
    }
    const credentials = new MemoryCredentials()
    const { host, route } = hostFor(hub, credentials)
    const account = new HubAccount(host)
    const started = await account.startSignIn({ version: '0.2.2', locale: 'zh-CN', timezoneOffsetSeconds: 0 }, 'http://127.0.0.1:4567', 'desktop')
    expect(started.attempt?.phase).toBe('initializing')
    await waitForPhase(account, 'waiting-browser')
    expect((await account.getState()).attempt?.authorizeUrl).toContain('/desktop/authorize?req=req-1')
    expect(route.path).toBe(HUB_CALLBACK_PATH)
    const start = hub.requests.find(entry => entry.path === '/api/desktop/auth/start')
    expect(start?.body).toMatchObject({ codeChallengeMethod: 'S256', redirectUri: 'http://127.0.0.1:4567/oauth/hub/callback' })
    // The browser arrives with the state the Hub echoed; a fresh Hub request is answered by the fake.
    const state = (start?.body as { state: string }).state
    hub.approve()
    const answered = new Promise<void>((resolve) => {
      const handler = route.handler
      if (handler === undefined) throw new Error('no callback route')
      handler({
        method: 'GET',
        url: `/oauth/hub/callback?code=code-1&state=${state}`,
        headers: {},
      } as IncomingMessage, {
        writeHead: () => ({ end: () => { resolve() } }),
        end: () => { resolve() },
      } as never)
    })
    await answered
    // The exchange settles asynchronously; wait for the attempt to reach `succeeded`.
    await waitForPhase(account, 'succeeded')
    const view = await account.getState()
    expect(view.status).toBe('credential-stored')
    expect(view.attempt?.phase).toBe('succeeded')
    expect(credentials.records.get(HUB_TOKEN_KEY)).toMatchObject({ kind: 'grant' })
    expect(credentials.refs.get(HUB_RELAY_REF)).toBe('sk-dsh-abc')
    const tokenRequest = hub.requests.find(entry => entry.path === '/api/desktop/auth/token')
    expect(tokenRequest?.body).toMatchObject({ code: 'code-1' })
    expect((tokenRequest?.body as { codeVerifier: string }).codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  })

  it('refuses a callback whose state does not match', async () => {
    const credentials = new MemoryCredentials()
    const { host, route } = hostFor(hub, credentials)
    const account = new HubAccount(host)
    await account.startSignIn({}, 'http://127.0.0.1:4567', 'desktop')
    await waitForPhase(account, 'waiting-browser')
    let status = 0
    const handler = route.handler
    if (handler === undefined) throw new Error('no callback route')
    handler({ method: 'GET', url: '/oauth/hub/callback?code=code-1&state=wrong', headers: {} } as IncomingMessage, {
      writeHead: (value: number) => { status = value; return { end: () => undefined } },
      end: () => undefined,
    } as never)
    expect(status).toBe(400)
    const view = await account.getState()
    expect(view.status).toBe('signed-out')
    await account.cancelSignIn(view.attempt?.id ?? '')
  })

  it('reports a failed exchange without storing anything', async () => {
    hub.tokenStatus = 400
    hub.tokenBody = { error: { code: 'pkce_mismatch', message: 'PKCE 校验失败' } }
    const credentials = new MemoryCredentials()
    const { host, route } = hostFor(hub, credentials)
    const account = new HubAccount(host)
    await account.startSignIn({}, 'http://127.0.0.1:4567', 'desktop')
    await waitForPhase(account, 'waiting-browser')
    const start = hub.requests.find(entry => entry.path === '/api/desktop/auth/start')
    const state = (start?.body as { state: string }).state
    const handler = route.handler
    if (handler === undefined) throw new Error('no callback route')
    handler({ method: 'GET', url: `/oauth/hub/callback?code=code-1&state=${state}`, headers: {} } as IncomingMessage, {
      writeHead: () => ({ end: () => undefined }),
      end: () => undefined,
    } as never)
    await waitForPhase(account, 'failed')
    const view = await account.getState()
    expect(view.status).toBe('signed-out')
    expect(view.attempt?.phase).toBe('failed')
    expect(view.attempt?.errorCode).toBe('protocol')
    expect(credentials.records.size).toBe(0)
  })

  it('rotates the token and drops the grant when the Hub rejects it', async () => {
    const credentials = new MemoryCredentials()
    const { host, events } = hostFor(hub, credentials)
    const account = new HubAccount(host)
    await credentials.modifyRecord(HUB_TOKEN_KEY, () => Promise.resolve({
      kind: 'grant',
      payload: {
        version: 1,
        token: 'dsh_dev_old',
        hubOrigin: hub.origin,
        deviceId: 'dv_0123456789abcdef0123456789abcdef',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 1_000_000).toISOString(),
        user: { username: 'alice', displayName: 'Alice', role: 'admin', roleLabel: '' },
        wallet: null,
      },
    }))
    await credentials.set(HUB_RELAY_REF, 'sk-dsh-abc')
    account.startLoops()
    let refreshed: { payload: { token: string } } | undefined
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const current = credentials.records.get(HUB_TOKEN_KEY) as { payload: { token: string } } | undefined
      if (current?.payload.token === 'dsh_dev_refreshed') {
        refreshed = current
        break
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const refresh = hub.requests.find(entry => entry.path === '/api/desktop/auth/refresh')
    expect(refresh?.authorization).toBe('Bearer dsh_dev_old')
    expect(refreshed?.payload.token).toBe('dsh_dev_refreshed')
    // A rejected device token removes the grant, emits the expiry notice, and keeps the account signed out.
    hub.sessionUnauthorized = true
    await account.refreshSession()
    expect(credentials.records.get(HUB_TOKEN_KEY)).toBeUndefined()
    expect(credentials.refs.get(HUB_RELAY_REF)).toBeUndefined()
    expect(events).toContain('deepseek-account/session-expired')
    expect((await account.getState()).status).toBe('signed-out')
    account.stopLoops()
    account.dispose()
  })

  it('signs out locally and tells the Hub', async () => {
    const credentials = new MemoryCredentials()
    const { host } = hostFor(hub, credentials)
    const account = new HubAccount(host)
    await credentials.modifyRecord(HUB_TOKEN_KEY, () => Promise.resolve({
      kind: 'grant',
      payload: {
        version: 1,
        token: 'dsh_dev_live',
        hubOrigin: hub.origin,
        deviceId: 'dv_0123456789abcdef0123456789abcdef',
        expiresAt: new Date(Date.now() + 100_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 1_000_000).toISOString(),
        user: { username: 'alice', displayName: 'Alice', role: 'user', roleLabel: '' },
        wallet: null,
      },
    }))
    const view = await account.signOut({})
    account.dispose()
    expect(view.status).toBe('signed-out')
    expect(credentials.records.get(HUB_TOKEN_KEY)).toBeUndefined()
    const logout = hub.requests.find(entry => entry.path === '/api/desktop/auth/logout')
    expect(logout?.authorization).toBe('Bearer dsh_dev_live')
  })
})

describe('search pool state', () => {
  let hub: FakeHub

  beforeEach(async () => {
    hub = new FakeHub()
    await hub.start()
  })

  afterEach(async () => {
    await hub.stop()
  })

  /** Seed a signed-in grant the way a completed login leaves one. */
  async function signedIn(credentials: MemoryCredentials, tools?: Record<string, unknown>): Promise<void> {
    await credentials.modifyRecord(HUB_TOKEN_KEY, () => Promise.resolve({
      kind: 'grant',
      payload: {
        version: 1,
        token: 'dsh_dev_live',
        hubOrigin: hub.origin,
        deviceId: 'dv_0123456789abcdef0123456789abcdef',
        expiresAt: new Date(Date.now() + 100_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 1_000_000).toISOString(),
        user: { username: 'alice', displayName: 'Alice', role: 'user', roleLabel: '' },
        wallet: null,
        ...tools === undefined ? {} : { tools },
      },
    }))
  }

  function storedTools(credentials: MemoryCredentials): unknown {
    const record = credentials.records.get(HUB_TOKEN_KEY)
    const payload = record?.kind === 'grant' ? record.payload as { tools?: unknown } : undefined
    return payload?.tools
  }

  it('reports the session tools member, normalized, and keeps it on the grant', async () => {
    const credentials = new MemoryCredentials()
    await signedIn(credentials)
    const { host, toolsCalls } = hostFor(hub, credentials)
    hub.sessionTools = { search: true, baseUrl: `${hub.origin}/v1/tools/` }
    const account = new HubAccount(host)
    await account.refreshSession()
    account.dispose()
    expect(toolsCalls.at(-1)).toEqual({ search: true, baseUrl: `${hub.origin}/v1/tools` })
    expect(storedTools(credentials)).toEqual({ search: true, baseUrl: `${hub.origin}/v1/tools` })
  })

  it('follows the switch back off', async () => {
    const credentials = new MemoryCredentials()
    await signedIn(credentials, { search: true, baseUrl: `${hub.origin}/v1/tools` })
    const { host, toolsCalls } = hostFor(hub, credentials)
    hub.sessionTools = { search: false, baseUrl: null }
    const account = new HubAccount(host)
    await account.refreshSession()
    account.dispose()
    expect(toolsCalls.at(-1)).toEqual({ search: false, baseUrl: null })
    expect(storedTools(credentials)).toEqual({ search: false, baseUrl: null })
  })

  it('treats a Hub that does not send tools as off (an older Hub clears served search)', async () => {
    const credentials = new MemoryCredentials()
    await signedIn(credentials, { search: true, baseUrl: 'https://hub.test/v1/tools' })
    const { host, toolsCalls } = hostFor(hub, credentials)
    const account = new HubAccount(host)
    await account.refreshSession()
    account.dispose()
    expect(toolsCalls.at(-1)).toEqual({ search: false, baseUrl: null })
  })

  it('reports off when the Hub rejects the device token (revocation clears the rows)', async () => {
    const credentials = new MemoryCredentials()
    await signedIn(credentials, { search: true, baseUrl: 'https://hub.test/v1/tools' })
    const { host, toolsCalls } = hostFor(hub, credentials)
    hub.sessionUnauthorized = true
    const account = new HubAccount(host)
    await account.refreshSession()
    account.dispose()
    expect(toolsCalls).toContainEqual({ search: false, baseUrl: null })
  })
})
