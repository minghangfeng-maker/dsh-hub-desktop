/**
 * `hubAgentModes`: the Cordis service the Claude Code and Codex pilots prefer.
 *
 * In a container the Hub injects `HUB_CLAUDE_KEY` / `HUB_CODEX_KEY` into the
 * process environment. A desktop has no such environment, so the connector
 * publishes the same facts as a service: the pilots inject
 * `hubAgentModes` when it exists and fall back to the environment when it does
 * not, which keeps container behavior byte-identical.
 *
 * The contract is the one in the pilots' `hub-agent-modes.d.ts`: `available` and
 * `credentials` are synchronous cache reads on the hot path (they run per model
 * call), and `refresh` is the only method that touches the network. The mode key
 * is exchanged with the device token (`POST /api/desktop/agent-mode-key`), stored
 * in the credential store under the pilot's own reference, and dropped when the
 * device signs out or is revoked.
 *
 * `baseUrl` follows the two existing call shapes exactly: the Claude plugin
 * appends `/v1/hub/agent-mode`, so it receives the origin without `/v1`; the
 * Codex plugin appends `/hub/agent-mode`, so it receives the origin with `/v1`.
 */

import type { CredentialKey, CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { HubRequestError, hubRequest } from './hub-client.ts'
import { info, warn } from './log.ts'

/** The two pilot scopes, identical to the Hub relay scopes. */
export type PilotScope = 'claude-code' | 'codex'

/** Credential references the mode keys are stored under (the pilots' env names). */
export const MODE_REFS: Readonly<Record<PilotScope, CredentialRef>> = {
  'claude-code': 'HUB_CLAUDE_KEY' as CredentialRef,
  codex: 'HUB_CODEX_KEY' as CredentialRef,
}

/** Credential records the connector keeps beside each key (no secret inside). */
export const MODE_RECORDS: Readonly<Record<PilotScope, CredentialKey>> = {
  'claude-code': 'hub-connector/mode-claude-code' as CredentialKey,
  codex: 'hub-connector/mode-codex' as CredentialKey,
}

/** One cached mode credential, in the shape the pilots consume. */
export interface HubAgentModeCredentials {
  /** Which environment variable the pilot injects the key as. */
  readonly auth: 'apiKey'
  /** The mode key (`sk-dsh-…`). */
  readonly key: string
  /** Relay base URL in the shape that pilot appends to. */
  readonly baseUrl: string
  /** Administrator-selected default model, when the Hub names one. */
  readonly model?: string
  /** Codex transport selection. */
  readonly wireApi?: 'responses' | 'chat'
  /** Account label the pilot shows. */
  readonly label: string
}

/** Result of {@link HubAgentModes.refresh}. */
export interface HubAgentModeRefreshResult {
  /** Whether a usable credential is cached afterwards. */
  readonly ok: boolean
  /** Hub-provided reason when it is not. */
  readonly error?: string
}

/** The service surface the pilots depend on. */
export interface HubAgentModesService {
  /** Whether this scope is currently served by the Hub. */
  available(scope: PilotScope): boolean
  /** Cached credentials, or null. */
  credentials(scope: PilotScope): HubAgentModeCredentials | null
  /** Re-read the key from the Hub. */
  refresh(scope: PilotScope, options?: { readonly force?: boolean }): Promise<HubAgentModeRefreshResult>
  /** Subscribe to changes for one scope. */
  onChange(scope: PilotScope, listener: () => void): () => void
}

/** A persisted mode record; the key itself lives in the credential reference. */
interface ModeRecord {
  readonly version: 1
  readonly baseUrl: string
  readonly keyId: number
  readonly label: string
}

/** What the service needs from the connector. */
export interface AgentModesHost {
  /** Current Hub origin, or '' when signed out. */
  hubOrigin(): string
  /** Current device token, or '' when signed out. */
  deviceToken(): Promise<string>
  /** Credential seam. */
  readonly credentials: CredentialProvider
}

/**
 * Convert a Hub relay base URL into the shape one pilot expects.
 * @param baseUrl - Hub-provided base URL, normally `<origin>/v1`.
 * @param scope - Pilot scope.
 * @returns The origin for `claude-code` (the plugin adds `/v1`), `<origin>/v1` for `codex`.
 */
export function baseUrlFor(baseUrl: string, scope: PilotScope): string {
  const trimmed = baseUrl.replace(/\/+$/u, '')
  if (scope === 'codex') return /\/v1$/u.test(trimmed) ? trimmed : `${trimmed}/v1`
  return trimmed.replace(/\/v1$/u, '')
}

/** Parse one stored mode record. */
function parseRecord(payload: unknown): ModeRecord | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = payload as Record<string, unknown>
  if (value.version !== 1 || typeof value.baseUrl !== 'string' || typeof value.label !== 'string') return undefined
  return { version: 1, baseUrl: value.baseUrl, keyId: typeof value.keyId === 'number' ? value.keyId : 0, label: value.label }
}

/** The `hubAgentModes` implementation. */
export class HubAgentModes implements HubAgentModesService {
  private readonly cache = new Map<PilotScope, HubAgentModeCredentials>()
  private readonly listeners = new Map<PilotScope, Set<() => void>>()
  private readonly inflight = new Map<PilotScope, Promise<HubAgentModeRefreshResult>>()

  /**
   * @param host - Origin/token accessors and the credential store.
   */
  constructor(private readonly host: AgentModesHost) {}

  /** @param scope - Pilot scope. @returns Whether a credential is cached for it. */
  available(scope: PilotScope): boolean {
    return this.cache.has(scope)
  }

  /** @param scope - Pilot scope. @returns The cached credential, or null. */
  credentials(scope: PilotScope): HubAgentModeCredentials | null {
    return this.cache.get(scope) ?? null
  }

  /**
   * Exchange the device token for this device's mode key.
   * @param scope - Pilot scope.
   * @param options - `force` re-reads even when a cached key exists.
   * @returns Whether a credential is cached afterwards.
   */
  async refresh(scope: PilotScope, options?: { readonly force?: boolean }): Promise<HubAgentModeRefreshResult> {
    const running = this.inflight.get(scope)
    if (running !== undefined) return running
    const task = this.readKey(scope, options?.force === true).finally(() => { this.inflight.delete(scope) })
    this.inflight.set(scope, task)
    return task
  }

  /**
   * Subscribe to changes for one scope.
   * @param scope - Pilot scope.
   * @param listener - Called after the cached credential changed.
   * @returns Unsubscribe function.
   */
  onChange(scope: PilotScope, listener: () => void): () => void {
    const set = this.listeners.get(scope) ?? new Set()
    set.add(listener)
    this.listeners.set(scope, set)
    return () => { set.delete(listener) }
  }

  /**
   * Load cached credentials from the credential store without a network call.
   * Runs at start-up and after a successful login, so the pilots see the right
   * answer on their first call.
   * @returns after every scope that has a stored key is in the cache.
   */
  async hydrate(): Promise<void> {
    for (const scope of ['claude-code', 'codex'] as const) {
      const record = await this.host.credentials.readRecord(MODE_RECORDS[scope])
      if (record === undefined || record.kind !== 'grant') continue
      const parsed = parseRecord(record.payload)
      if (parsed === undefined) continue
      // The key itself lives in the credential reference; the record only describes it.
      const key = (await this.host.credentials.resolve(MODE_REFS[scope]))?.value
      if (key === undefined || key === '') continue
      this.cache.set(scope, {
        auth: 'apiKey',
        key,
        baseUrl: baseUrlFor(parsed.baseUrl, scope),
        ...scope === 'codex' ? { wireApi: 'responses' as const } : {},
        label: parsed.label,
      })
    }
  }

  /**
   * Drop every cached credential and notify the pilots.
   * Runs on sign-out and on device revocation.
   * @param notify - Whether to notify subscribers.
   */
  clear(notify = true): void {
    this.cache.clear()
    if (notify) for (const scope of this.listeners.keys()) this.emit(scope)
  }

  /** Notify every listener registered for one scope. */
  private emit(scope: PilotScope): void {
    for (const listener of this.listeners.get(scope) ?? []) {
      try {
        listener()
      } catch (error) {
        warn(`an agent-mode listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Perform the network exchange and update cache plus store. */
  private async readKey(scope: PilotScope, force: boolean): Promise<HubAgentModeRefreshResult> {
    const origin = this.host.hubOrigin()
    if (origin === '') {
      this.cache.delete(scope)
      return { ok: false, error: '请先登录 DSH Hub' }
    }
    const token = await this.host.deviceToken()
    if (token === '') {
      this.cache.delete(scope)
      return { ok: false, error: '请先登录 DSH Hub' }
    }
    if (!force && this.cache.has(scope)) return { ok: true }
    try {
      const response = await hubRequest<{
        mode: PilotScope
        keyId: number
        secret: string
        baseUrl: string
      }>({
        url: `${origin}/api/desktop/agent-mode-key`,
        method: 'POST',
        token,
        body: { mode: scope },
      })
      const body = response.body
      if (body === undefined || typeof body.secret !== 'string' || typeof body.baseUrl !== 'string') {
        return { ok: false, error: 'Hub 返回的模式密钥不完整' }
      }
      await this.host.credentials.set(MODE_REFS[scope], body.secret)
      await this.host.credentials.modifyRecord(MODE_RECORDS[scope], () => Promise.resolve({
        kind: 'grant',
        payload: { version: 1, baseUrl: body.baseUrl, keyId: typeof body.keyId === 'number' ? body.keyId : 0, label: 'DSH Hub' } satisfies ModeRecord,
      }))
      this.cache.set(scope, {
        auth: 'apiKey',
        key: body.secret,
        baseUrl: baseUrlFor(body.baseUrl, scope),
        ...scope === 'codex' ? { wireApi: 'responses' as const } : {},
        label: 'DSH Hub',
      })
      info(`agent mode ${scope} is served by the Hub`)
      this.emit(scope)
      return { ok: true }
    } catch (error) {
      this.cache.delete(scope)
      const detail = error instanceof HubRequestError ? error.message : error instanceof Error ? error.message : String(error)
      warn(`agent mode ${scope} is unavailable (${detail})`)
      this.emit(scope)
      return { ok: false, error: detail }
    }
  }
}
