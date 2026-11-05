/**
 * The Hub account: DSH's account service backed by a DSH Hub device grant.
 *
 * The composition replaces the upstream `deepseek-account` provider with this
 * one (D2 option A), so every existing consumer keeps working unchanged: the
 * desktop welcome gate, the sidebar account menu, the settings account page, and
 * the expiry notice all read the same `AccountView`/`AccountDetails` surface.
 * What changes is who issues the grant and what it can do.
 *
 * Login is the upstream shape with a different peer: a system-browser
 * authorization page, a loopback callback registered on the Host's own
 * webserver, PKCE S256, and one code exchange. The device token and the device's
 * relay key are written into the credential store — never into `process.env`,
 * which every agent subprocess can read.
 *
 * Token rules: one rotating device token, 30-day sliding, 90-day
 * absolute, no separate refresh token. A 401 means the device was revoked or the
 * token expired: the local grant is removed, `signed-out` is emitted, and local
 * sessions are left untouched — the shell decides whether that means the welcome
 * window.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CredentialKey, CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { hubRequest, HubRequestError, isDeviceTokenInvalid, normalizeHubOrigin } from './hub-client.ts'
import type { BuildIdentity } from './device.ts'
import type { HubState } from './state.ts'
import { describeDevice } from './device.ts'
import { NO_HUB_SEARCH, normalizeSearchTools, type HubSessionTools } from './search.ts'
import { info, warn } from './log.ts'

/** Credential record holding the device grant. */
export const HUB_TOKEN_KEY = 'hub-connector/token' as CredentialKey

/** Credential reference the Hub relay key is stored under (the Hub's own env name). */
export const HUB_RELAY_REF = 'HUB_MK_HUB' as CredentialRef

/** Credential references for the two pilot modes (the pilots' own env names). */
export const HUB_AGENT_MODE_REFS: Readonly<Record<'claude-code' | 'codex', CredentialRef>> = {
  'claude-code': 'HUB_CLAUDE_KEY' as CredentialRef,
  codex: 'HUB_CODEX_KEY' as CredentialRef,
}

/** Loopback callback path the authorization page redirects to. */
export const HUB_CALLBACK_PATH = '/oauth/hub/callback'

/** Attempt lifetime; the Hub expires its pending request after 10 minutes. */
const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000

/** Re-check the token this often; the Hub rotates on every refresh call. */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Renew early when the sliding window has less than this left. */
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000

/** Session poll interval while signed in. */
const SESSION_POLL_MS = 60 * 1000

/**
 * How long a sign-out waits for the Hub to acknowledge the revocation.
 *
 * Revocation is best effort and the local grant is already gone by then; a switch
 * of Hub origin must not stall on a Hub the user is leaving behind.
 */
const REVOKE_TIMEOUT_MS = 5000

/** Attempt phases that mean a login is still in flight. */
const ACTIVE_ATTEMPT_PHASES: readonly SignInAttemptView['phase'][] = ['initializing', 'waiting-browser', 'exchanging', 'committing']


/** Account links the client renders; the Hub's own pages. */
export interface AccountLinks {
  readonly usageUrl: string
  readonly topUpUrl: string
}

/** One login attempt as the client sees it. */
export interface SignInAttemptView {
  readonly id: string
  readonly phase: 'initializing' | 'waiting-browser' | 'exchanging' | 'committing' | 'succeeded' | 'cancelled' | 'expired' | 'failed'
  readonly authorizeUrl?: string
  readonly expiresAt?: number
  readonly errorCode?: 'no-response' | 'network' | 'protocol' | 'expired' | 'storage'
}

/** The account snapshot consumers subscribe to. */
export interface HubAccountView {
  readonly status: 'signed-out' | 'credential-stored'
  readonly links: AccountLinks
  readonly attempt: SignInAttemptView | null
}

/** The Hub's answer to `GET /api/desktop/session`, as this provider keeps it. */
export interface HubSessionUser {
  readonly username: string
  readonly displayName: string
  readonly role: 'user' | 'admin'
  readonly roleLabel: string
}

/** Wallet snapshot; `balance` is integer micro-points (1 point = 1e6). */
export interface HubWallet {
  readonly balance: number
  readonly unit: 'micro-point'
}

/** The stored grant: everything the account surface can render offline. */
export interface HubGrant {
  readonly version: 1
  readonly token: string
  readonly hubOrigin: string
  readonly deviceId: string
  readonly expiresAt: string
  readonly absoluteExpiresAt: string
  readonly user: HubSessionUser
  readonly wallet: HubWallet | null
  /**
   * Search-pool state from the last session read. Kept beside the wallet so a
   * restart renders the same search configuration before the first session poll answers.
   */
  readonly tools?: HubSessionTools
}

/** What the provider is allowed to reach outside itself. */
export interface AccountHost {
  /** Current build identity, for the device description. */
  readonly build: BuildIdentity
  /** Process environment the Host launched with. */
  readonly environment: NodeJS.ProcessEnv
  /** Credential seam. */
  readonly credentials: CredentialProvider
  /** Register one exact route on the Host webserver; returns its disposer. */
  registerRoute(path: string, handler: (request: IncomingMessage, response: ServerResponse) => void): () => void
  /** Current Hub origin; may throw when the deployment configured none. */
  hubOrigin(): string
  /** Durable connector state. */
  readState(): HubState
  /** Persist a state change. */
  writeState(next: HubState): void
  /** Emit one Cordis event by name. */
  emit(event: string): void
  /**
   * Report the session's search-pool state: called on every session read, and
   * with "off" on sign-out or token revocation. The connector owns the overlay rows;
   * the provider only reads the session.
   */
  sessionTools?(tools: HubSessionTools): void
  /** Notify account watchers. */
  changed(identityOnly?: boolean): void
  /** Clock, injectable for tests. */
  now(): Date
  /** Random bytes, injectable for tests. */
  random(size: number): Buffer
}

/** Mutable login attempt. */
interface Attempt {
  readonly id: string
  readonly origin: string
  view: SignInAttemptView
  controller: AbortController
  /** Set once the browser callback arrived, so a second callback can be refused. */
  callbackLanded: boolean
  done: Promise<void>
}

/** The parsed `POST /api/desktop/auth/token` response, as this provider uses it. */
interface ExchangeResult {
  token: string
  expiresAt: string
  absoluteExpiresAt: string
  user: HubSessionUser
  wallet: HubWallet | null
  device: { readonly deviceId: string; readonly name: string }
  relay: { readonly secret: string; readonly ref: string; readonly baseUrl: string } | null
}

/** Narrow an unknown value to a plain record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a string member, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Validate one stored grant payload.
 * @param payload - Record payload, written by this provider.
 * @returns The grant, or undefined when the payload is not one this build understands.
 */
export function parseGrant(payload: unknown): HubGrant | undefined {
  const value = record(payload)
  if (value === undefined || value.version !== 1) return undefined
  const token = text(value.token)
  const hubOrigin = text(value.hubOrigin)
  const deviceId = text(value.deviceId)
  const expiresAt = text(value.expiresAt)
  const absoluteExpiresAt = text(value.absoluteExpiresAt)
  const user = record(value.user)
  const username = text(user?.username)
  const displayName = text(user?.displayName)
  const role = user?.role === 'admin' || user?.role === 'user' ? user.role : undefined
  if (token === undefined || hubOrigin === undefined || deviceId === undefined || expiresAt === undefined
    || absoluteExpiresAt === undefined || username === undefined || displayName === undefined || role === undefined) {
    return undefined
  }
  const wallet = record(value.wallet)
  const balance = wallet?.balance
  const tools = normalizeSearchTools(value.tools)
  return {
    version: 1,
    token,
    hubOrigin,
    deviceId,
    expiresAt,
    absoluteExpiresAt,
    user: { username, displayName, role, roleLabel: text(user?.roleLabel) ?? '' },
    wallet: typeof balance === 'number' ? { balance, unit: 'micro-point' } : null,
    tools,
  }
}

/**
 * Constant-time comparison of two base64url strings of any length.
 * @param left - Received value.
 * @param right - Expected value.
 * @returns Whether they are equal, comparing every byte.
 */
export function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.byteLength !== b.byteLength) {
    // Compare anyway so the timing does not depend on the length check alone.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

/**
 * Derive the S256 PKCE challenge for one verifier.
 * @param verifier - 32 random bytes in base64url form.
 * @returns `base64url(sha256(verifier))`.
 */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Convert micro-points to the decimal string the account page shows.
 * @param micro - Integer micro-points.
 * @returns Two-decimal point amount, e.g. `1234.50`.
 */
export function pointsText(micro: number): string {
  const whole = Math.trunc(micro / 1_000_000)
  const fraction = Math.abs(micro % 1_000_000)
  return `${String(whole)}.${String(Math.round(fraction / 10_000)).padStart(2, '0')}`
}

/**
 * Format the role for the account row.
 * @param user - Session user from the Hub.
 * @returns `管理员` for admins, else the custom role label, else `普通用户`.
 */
export function roleText(user: HubSessionUser): string {
  if (user.role === 'admin') return '管理员'
  return user.roleLabel.trim() === '' ? '普通用户' : user.roleLabel
}

/** The Hub account provider. */
export class HubAccount {
  private attempt: Attempt | undefined
  private readonly listeners = new Set<(identityOnly: boolean) => void>()
  private readonly lifetime = new AbortController()
  private refreshTimer: ReturnType<typeof setInterval> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  /** Serializes session polls so an explicit refresh always reads after an in-flight one. */
  private pollChain: Promise<void> = Promise.resolve()
  private disposed = false
  /** Cached profile facts for the signed-in account. */
  private cachedUser: { readonly user: HubSessionUser; readonly wallet: HubWallet | null } | undefined
  /** Last ETag from `GET /api/desktop/session`. */
  private sessionEtag: string | undefined
  /** Search-pool state the last session read reported, for change detection. */
  private cachedTools: HubSessionTools | undefined

  /**
   * @param host - Credential seam, routes, clock, and durable state.
   */
  constructor(private readonly host: AccountHost) {}

  /** Current account snapshot. @returns Status, links, and the latest attempt. */
  async getState(): Promise<HubAccountView> {
    const grant = await this.readGrant()
    return {
      status: grant === undefined ? 'signed-out' : 'credential-stored',
      links: this.links(),
      attempt: this.attempt?.view ?? null,
    }
  }

  /**
   * Start or join the browser authorization attempt.
   * @param _client - Requesting UI identity; the Hub request carries its own locale-less body.
   * @param callbackOrigin - The Host's browser-facing loopback origin.
   * @param _loginSource - Initiating surface, kept for signature compatibility.
   * @returns The snapshot with the attempt in `waiting-browser`.
   */
  async startSignIn(_client: unknown, callbackOrigin: string, _loginSource: 'web' | 'desktop'): Promise<HubAccountView> {
    const running = this.attempt
    if (running !== undefined && ACTIVE_ATTEMPT_PHASES.includes(running.view.phase)) {
      return this.getState()
    }
    if (running !== undefined) await running.done
    let origin: string
    try {
      origin = normalizeHubOrigin(this.host.hubOrigin())
    } catch (error) {
      warn(`login is unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return { status: (await this.readGrant()) === undefined ? 'signed-out' : 'credential-stored', links: this.links(), attempt: null }
    }
    const attempt: Attempt = {
      id: this.host.random(16).toString('hex'),
      origin,
      view: { id: '', phase: 'initializing' },
      controller: new AbortController(),
      callbackLanded: false,
      done: Promise.resolve(),
    }
    attempt.view = { id: attempt.id, phase: 'initializing' }
    this.attempt = attempt
    attempt.done = this.run(attempt, callbackOrigin).catch((error: unknown) => {
      const code = error instanceof HubRequestError ? this.errorCodeOf(error) : 'protocol'
      warn(`login failed (${code})`)
      this.update(attempt, { phase: code === 'expired' ? 'expired' : 'failed', errorCode: code })
    })
    this.notifyChanged()
    return this.getState()
  }

  /**
   * Cancel one attempt, leaving a settled attempt alone.
   * @param id - Attempt id from {@link getState}.
   * @returns The snapshot after cancellation started settling.
   */
  async cancelSignIn(id: string): Promise<HubAccountView> {
    const attempt = this.attempt
    if (attempt?.id === id && attempt.view.phase !== 'committing') {
      attempt.controller.abort()
      this.update(attempt, { phase: 'cancelled' })
    }
    return this.getState()
  }

  /**
   * Whether a login attempt is still in flight.
   *
   * An attempt names the Hub origin it started against, so a caller that is about
   * to change that origin must ask this first.
   * @returns True while the attempt is initializing, waiting for the browser, exchanging, or committing.
   */
  isSigningIn(): boolean {
    const phase = this.attempt?.view.phase
    return phase !== undefined && ACTIVE_ATTEMPT_PHASES.includes(phase)
  }

  /**
   * Remove the local grant and revoke the device token at the Hub.
   * @param _client - Requesting UI identity; unused.
   * @returns The signed-out snapshot.
   */
  async signOut(_client: unknown): Promise<HubAccountView> {
    const grant = await this.readGrant()
    this.stopLoops()
    this.cachedUser = undefined
    this.sessionEtag = undefined
    this.cachedTools = undefined
    this.host.sessionTools?.(NO_HUB_SEARCH)
    await this.host.credentials.deleteRecord(HUB_TOKEN_KEY)
    await this.host.credentials.unset(HUB_RELAY_REF)
    for (const ref of Object.values(HUB_AGENT_MODE_REFS)) await this.host.credentials.unset(ref)
    this.host.emit('hub-connector/signed-out')
    this.host.emit('deepseek-account/signed-out')
    this.notifyChanged()
    if (grant !== undefined) {
      // Revocation is best effort: the local grant is already gone, which is what the user asked for.
      try {
        await hubRequest({
          url: `${grant.hubOrigin}/api/desktop/auth/logout`,
          method: 'POST',
          token: grant.token,
          body: {},
          timeoutMs: REVOKE_TIMEOUT_MS,
        })
        info('signed out; the Hub revoked this device token')
      } catch (error) {
        warn(`signed out locally; the Hub could not be told (${error instanceof HubRequestError ? error.code : 'network'})`)
      }
    }
    return this.getState()
  }

  /**
   * Subscribe to snapshots, delivering the current one first.
   * @param signal - Subscription lifetime.
   * @param _includeIdentityChanges - Accepted for signature compatibility; identity changes always notify.
   * @returns Snapshots as they change.
   */
  async *watch(signal: AbortSignal, _includeIdentityChanges = false): AsyncIterable<HubAccountView> {
    yield await this.getState()
    const queue: HubAccountView[] = []
    let notify: (() => void) | undefined
    const listener = (): void => {
      void this.getState().then((view) => {
        queue.push(view)
        notify?.()
      })
    }
    this.listeners.add(listener)
    const onAbort = (): void => { notify?.() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!signal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { notify = () => { notify = undefined; resolve() } })
        }
        while (queue.length > 0) {
          const next = queue.shift()
          if (next !== undefined) yield next
        }
      }
    } finally {
      this.listeners.delete(listener)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Read the account profile for the account row.
   * The Hub is the identity provider, so this answers from the cached session
   * snapshot rather than issuing a second request per render.
   * @param _client - Requesting UI identity; unused.
   * @returns Profile outcome, or null while signed out.
   */
  async getProfile(_client: unknown): Promise<{ readonly status: 'ready'; readonly value: { readonly id: string | null; readonly name: string | null; readonly contact: string | null; readonly avatarUrl: string | null } } | null> {
    const cached = await this.sessionFacts()
    if (cached === undefined) return null
    return {
      status: 'ready',
      value: {
        id: null,
        name: cached.user.displayName === '' ? cached.user.username : cached.user.displayName,
        contact: `${roleText(cached.user)} · ${cached.wallet === null ? '—' : pointsText(cached.wallet.balance)} 积分`,
        avatarUrl: null,
      },
    }
  }

  /**
   * Read the wallet for the settings account page.
   * @param _client - Requesting UI identity; unused.
   * @returns One CNY-shaped wallet carrying the Hub points, or null while signed out.
   */
  async getBalance(_client: unknown): Promise<{
    readonly status: 'ready'
    readonly value: readonly { readonly currency: 'CNY'; readonly balance: string }[]
    readonly bonusWallets: readonly { readonly currency: 'CNY'; readonly balance: string }[]
  } | null> {
    const cached = await this.sessionFacts()
    if (cached === undefined) return null
    return {
      status: 'ready',
      value: cached.wallet === null ? [] : [{ currency: 'CNY', balance: pointsText(cached.wallet.balance) }],
      bonusWallets: [],
    }
  }

  /**
   * The Hub grants no bonus orders.
   * @returns Always null.
   */
  async getUnnotifiedBonuses(): Promise<null> {
    return null
  }

  /**
   * Acknowledge a bonus notice; the Hub never issues one.
   * @returns Always false.
   */
  async ackBonusNotified(): Promise<boolean> {
    return false
  }

  /**
   * Resolve an inference credential for a model request.
   * The Hub relay authenticates with its own `sk-dsh-…` key through the
   * `HUB_MK_HUB` reference, so the device token must never ride a model request.
   * @returns Always undefined.
   */
  async resolveToken(): Promise<undefined> {
    return undefined
  }

  /** Inference rejection of the device token; nothing to remove. */
  async rejectToken(): Promise<void> {
    // The device token is a control-plane credential; model requests never carry it.
  }

  /**
   * The embedded Platform document belongs to the upstream provider.
   * @returns Always null.
   */
  async getPlatformSession(): Promise<null> {
    return null
  }

  /**
   * Identity facts for the device report.
   * @returns The stored device id and account id, plus the OS version string the Hub records.
   */
  async getDeviceIdentity(): Promise<{ deviceId?: string; userId?: string; osVersion: string }> {
    const state = this.host.readState()
    return {
      ...state.deviceId === null ? {} : { deviceId: state.deviceId },
      osVersion: process.version,
    }
  }

  /**
   * Read the stored grant, if it belongs to the currently configured Hub.
   * A grant issued by another Hub origin is discarded: it could only fail, and
   * keeping it would make the account page claim a login that cannot work.
   * @returns The grant, or undefined.
   */
  async readGrant(): Promise<HubGrant | undefined> {
    const record = await this.host.credentials.readRecord(HUB_TOKEN_KEY)
    if (record === undefined || record.kind !== 'grant') return undefined
    const grant = parseGrant(record.payload)
    if (grant === undefined) return undefined
    let origin: string
    try {
      origin = normalizeHubOrigin(this.host.hubOrigin())
    } catch {
      return undefined
    }
    if (grant.hubOrigin !== origin) {
      warn('the stored login belongs to a different Hub origin; sign in again')
      await this.host.credentials.deleteRecord(HUB_TOKEN_KEY)
      this.host.changed()
      return undefined
    }
    return grant
  }

  /**
   * Begin periodic refresh and session polling for a signed-in account.
   * Idempotent: a second call re-arms the same timers.
   */
  startLoops(): void {
    if (this.disposed) return
    this.stopLoops()
    this.refreshTimer = setInterval(() => { void this.refreshToken() }, REFRESH_INTERVAL_MS)
    this.refreshTimer.unref?.()
    this.pollTimer = setInterval(() => { void this.pollSession() }, SESSION_POLL_MS)
    this.pollTimer.unref?.()
    void this.refreshToken()
    void this.pollSession()
  }

  /** Stop the refresh and session timers. */
  stopLoops(): void {
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer)
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.refreshTimer = undefined
    this.pollTimer = undefined
  }

  /** Dispose watchers and timers; the account service is going away. */
  dispose(): void {
    this.disposed = true
    this.stopLoops()
    this.lifetime.abort()
    this.listeners.clear()
  }

  /**
   * Pull the account snapshot from the Hub now — after a turn settled, when the
   * window regained focus, or when the account page opens.
   * @returns after the snapshot was read; failures keep the cached facts.
   */
  async refreshSession(): Promise<void> {
    await this.pollSession()
  }

  /** Rotate the device token, leaving the stored grant alone on failure. */
  private async refreshToken(): Promise<void> {
    const grant = await this.readGrant()
    if (grant === undefined || this.disposed) return
    const remaining = Date.parse(grant.expiresAt) - this.host.now().getTime()
    if (Number.isFinite(remaining) && remaining > RENEW_BEFORE_MS) return
    try {
      const response = await hubRequest<{ token: string; expiresAt: string; absoluteExpiresAt: string }>({
        url: `${grant.hubOrigin}/api/desktop/auth/refresh`,
        method: 'POST',
        token: grant.token,
        body: {},
      })
      const body = response.body
      if (body === undefined) return
      await this.patchGrant(current => ({
        ...current,
        token: body.token,
        expiresAt: body.expiresAt,
        absoluteExpiresAt: body.absoluteExpiresAt,
      }))
    } catch (error) {
      if (isDeviceTokenInvalid(error)) await this.expire('the Hub rejected this device token')
      else warn(`token refresh failed (${error instanceof HubRequestError ? error.code : 'network'})`)
    }
  }

  /** Read `GET /api/desktop/session` with an ETag, keeping the last snapshot on failure. */
  private async pollSession(): Promise<void> {
    this.pollChain = this.pollChain.then(() => this.readSession()).catch(() => undefined)
    return this.pollChain
  }

  /** One session read, run after any poll already in flight. */
  private async readSession(): Promise<void> {
    if (this.disposed) return
    const grant = await this.readGrant()
    if (grant === undefined) return
    try {
      const response = await hubRequest<{
        user: { username: string; displayName: string; role: 'user' | 'admin'; roleLabel: string }
        wallet: HubWallet | null
        device: { deviceId: string; name: string }
        tools?: { search: boolean; baseUrl: string | null }
      }>({
        url: `${grant.hubOrigin}/api/desktop/session`,
        token: grant.token,
        ...this.sessionEtag === undefined ? {} : { headers: { 'if-none-match': this.sessionEtag } },
      })
      if (response.status === 304) return
      const body = response.body
      if (body === undefined) return
      this.sessionEtag = response.etag
      const next = { user: body.user, wallet: body.wallet }
      const changed = JSON.stringify(next) !== JSON.stringify(this.cachedUser)
      this.cachedUser = next
      // An older Hub omits `tools`; normalizeSearchTools turns that into "off", so a
      // downgrade clears served search instead of leaving a stale endpoint behind.
      const tools = normalizeSearchTools(body.tools)
      const toolsChanged = this.cachedTools === undefined
        ? tools.search || tools.baseUrl !== null
        : JSON.stringify(tools) !== JSON.stringify(this.cachedTools)
      this.cachedTools = tools
      await this.patchGrant(current => ({ ...current, user: body.user, wallet: body.wallet, tools }))
      this.host.sessionTools?.(tools)
      const state = this.host.readState()
      if (body.device.deviceId !== state.deviceId) this.host.writeState({ ...state, deviceId: body.device.deviceId })
      if (changed || toolsChanged) this.notifyChanged(true)
    } catch (error) {
      if (isDeviceTokenInvalid(error)) await this.expire('the Hub rejected this device token')
      else warn(`session refresh failed (${error instanceof HubRequestError ? error.code : 'network'})`)
    }
  }

  /** Drop the grant after a rejection and tell the shell. */
  private async expire(reason: string): Promise<void> {
    warn(`${reason}; signing out locally and keeping every local session`)
    this.stopLoops()
    this.cachedUser = undefined
    this.sessionEtag = undefined
    this.cachedTools = undefined
    this.host.sessionTools?.(NO_HUB_SEARCH)
    await this.host.credentials.deleteRecord(HUB_TOKEN_KEY)
    await this.host.credentials.unset(HUB_RELAY_REF)
    for (const ref of Object.values(HUB_AGENT_MODE_REFS)) await this.host.credentials.unset(ref)
    this.host.emit('deepseek-account/session-expired')
    this.host.emit('hub-connector/signed-out')
    this.notifyChanged()
  }

  /**
   * Patch the stored grant against its current value.
   *
   * A rotation and a session refresh both read the grant and write one field of
   * it. Spreading a captured copy would make the slower writer restore stale
   * fields — a rotated token silently reverting to the revoked one — so every
   * write re-reads the record inside the seam's serialized mutation.
   * @param patch - Receives the current grant; returning undefined leaves the record alone.
   */
  private async patchGrant(patch: (current: HubGrant) => HubGrant | undefined): Promise<void> {
    await this.host.credentials.modifyRecord(HUB_TOKEN_KEY, (current) => {
      if (current === undefined || current.kind !== 'grant') return Promise.resolve(undefined)
      const parsed = parseGrant(current.payload)
      if (parsed === undefined) return Promise.resolve(undefined)
      const next = patch(parsed)
      return Promise.resolve(next === undefined ? undefined : { kind: 'grant', payload: next })
    })
  }

  /** Cached session facts, refreshed lazily when the account page asks first. */
  private async sessionFacts(): Promise<{ user: HubSessionUser; wallet: HubWallet | null } | undefined> {
    const grant = await this.readGrant()
    if (grant === undefined) return undefined
    if (this.cachedUser === undefined) {
      this.cachedUser = { user: grant.user, wallet: grant.wallet }
      void this.pollSession()
    }
    return this.cachedUser
  }

  /** Map a Hub failure onto the account's documented error codes. */
  private errorCodeOf(error: HubRequestError): 'no-response' | 'network' | 'protocol' | 'expired' | 'storage' {
    if (error.code === 'no-response' || error.code === 'timeout') return 'no-response'
    if (error.code === 'expired' || error.status === 410) return 'expired'
    if (error.status === 0) return 'network'
    return 'protocol'
  }

  /** The links the account surfaces render. */
  private links(): AccountLinks {
    let origin = ''
    try {
      origin = normalizeHubOrigin(this.host.hubOrigin())
    } catch {
      origin = ''
    }
    // The Hub's points and usage live on one page (/usage); online top-up is not offered yet.
    return { usageUrl: `${origin}/usage`, topUpUrl: `${origin}/usage` }
  }

  /**
   * Tell every account watcher that the snapshot changed.
   *
   * The desktop shell's login gate is one of these watchers: it enters the
   * workspace when the attempt reaches `succeeded`. A change that only reached
   * the connector's own listeners would leave the welcome window on screen after
   * a successful login.
   * @param identityOnly - Whether only the cached platform identity changed.
   */
  private notifyChanged(identityOnly = false): void {
    for (const listener of this.listeners) listener(identityOnly)
    this.host.changed()
  }

  /** Replace the visible attempt view and notify watchers. */
  private update(attempt: Attempt, value: Partial<SignInAttemptView>): void {
    const { authorizeUrl: _authorizeUrl, ...rest } = attempt.view
    attempt.view = { ...rest, ...value }
    this.notifyChanged()
  }

  /** The whole browser + exchange flow for one attempt. */
  private async run(attempt: Attempt, callbackOrigin: string): Promise<void> {
    const verifier = this.host.random(32).toString('base64url')
    const state = this.host.random(32).toString('base64url')
    const challenge = codeChallenge(verifier)
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort() }, ATTEMPT_TIMEOUT_MS)
    const signal = AbortSignal.any([attempt.controller.signal, deadline.signal])
    const landed = Promise.withResolvers<{ code?: string; error?: string }>()
    void landed.promise.catch(() => undefined)
    let disposeRoute: (() => void) | undefined
    try {
      disposeRoute = this.host.registerRoute(HUB_CALLBACK_PATH, (request, response) => {
        let url: URL
        try {
          url = new URL(request.url ?? '/', 'http://127.0.0.1')
        } catch {
          response.writeHead(400, { 'cache-control': 'no-store' }).end()
          return
        }
        const receivedState = url.searchParams.get('state') ?? ''
        const single = url.searchParams.getAll('state').length === 1
        if (request.method !== 'GET' || !single || !sameSecret(receivedState, state)) {
          response.writeHead(400, { 'cache-control': 'no-store' }).end()
          return
        }
        if (attempt.callbackLanded || attempt.view.phase !== 'waiting-browser') {
          response.writeHead(410, { 'cache-control': 'no-store' }).end()
          return
        }
        attempt.callbackLanded = true
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end('<!doctype html><meta charset="utf-8"><title>DSH Hub</title>'
            + '<p>登录已完成，请返回 DSH Hub 桌面端。'
            + '<script>setTimeout(function(){window.close()},800)</script>')
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        landed.resolve({ ...code === null ? {} : { code }, ...error === null ? {} : { error } })
      })
      signal.throwIfAborted()
      const device = describeDevice({ build: this.host.build, state: this.host.readState(), environment: this.host.environment })
      const started = await hubRequest<{ requestId: string; authorizeUrl: string; expiresAt: string }>({
        url: `${attempt.origin}/api/desktop/auth/start`,
        method: 'POST',
        signal,
        body: {
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          state,
          redirectUri: `${callbackOrigin}${HUB_CALLBACK_PATH}`,
          locale: 'zh-CN',
          device,
        },
      })
      const start = started.body
      if (start === undefined) throw new HubRequestError('protocol', 'the Hub returned no authorization request', 200)
      this.update(attempt, { phase: 'waiting-browser', authorizeUrl: start.authorizeUrl, expiresAt: Date.parse(start.expiresAt) })
      // The authorize page is the browser half of the login: an operator (or the
      // account page) needs this exact URL. It carries the pending request id only —
      // never the verifier, the state, or a token.
      info(`login: open this URL to authorize this device — ${start.authorizeUrl}`)
      const answered = await landed.promise
      signal.throwIfAborted()
      if (answered.error !== undefined) {
        throw new HubRequestError('access_denied', 'the browser authorization was refused', 403)
      }
      if (answered.code === undefined) throw new HubRequestError('protocol', 'the callback carried no authorization code', 400)
      this.update(attempt, { phase: 'exchanging' })
      const exchanged = await hubRequest<ExchangeResult>({
        url: `${attempt.origin}/api/desktop/auth/token`,
        method: 'POST',
        signal,
        body: { code: answered.code, codeVerifier: verifier },
      })
      const result = exchanged.body
      if (result === undefined || typeof result.token !== 'string' || typeof result.device?.deviceId !== 'string') {
        throw new HubRequestError('protocol', 'the Hub returned no device grant', 200)
      }
      this.update(attempt, { phase: 'committing' })
      const grant: HubGrant = {
        version: 1,
        token: result.token,
        hubOrigin: attempt.origin,
        deviceId: result.device.deviceId,
        expiresAt: result.expiresAt,
        absoluteExpiresAt: result.absoluteExpiresAt,
        user: result.user,
        wallet: result.wallet,
      }
      await this.host.credentials.modifyRecord(HUB_TOKEN_KEY, () => Promise.resolve({ kind: 'grant', payload: grant }))
      // The Hub always names the container-compatible reference; this build only knows that one.
      if (result.relay !== null) await this.host.credentials.set(HUB_RELAY_REF, result.relay.secret)
      const stored = this.host.readState()
      this.host.writeState({ ...stored, deviceId: result.device.deviceId })
      this.cachedUser = { user: result.user, wallet: result.wallet }
      this.update(attempt, { phase: 'succeeded' })
      info(`signed in to ${attempt.origin} as ${result.user.username} (device ${result.device.deviceId})`)
      this.host.emit('hub-connector/signed-in')
      this.startLoops()
    } catch (error) {
      if (deadline.signal.aborted) throw new HubRequestError('expired', 'the authorization request expired', 410)
      throw error
    } finally {
      clearTimeout(timer)
      disposeRoute?.()
    }
  }
}
