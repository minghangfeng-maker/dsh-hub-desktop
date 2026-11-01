/**
 * The connector's orchestration: one object that owns the state file, the
 * account, the agent-mode service, and the two Hub conversations (heartbeat and
 * manifest).
 *
 * Everything here is deliberately pull-based. The Hub never connects to a
 * desktop; the device tells the Hub it is alive on the interval the Hub asks for,
 * and pulls the manifest when the Hub's answer names a revision it has not
 * applied. A failure in either conversation is reported, never retried into a
 * tight loop, and never takes the Host down.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import type { AccountHost, HubAccount, HubGrant } from './account.ts'
import { HUB_RELAY_REF } from './account.ts'
import { HubAgentModes } from './agent-modes.ts'
import type { AgentModesHost } from './agent-modes.ts'
import type { BuildIdentity } from './device.ts'
import { HubRequestError, hubRequest, isDeviceTokenInvalid, normalizeHubOrigin } from './hub-client.ts'
import { info, warn } from './log.ts'
import {
  applyManifest,
  downloadArtifact,
  type ArtifactDownloadOptions,
  loadManifestSchema,
  pruneCache,
  validateManifest,
  type ArtifactRef,
  type ChangeOutcome,
  type InstalledBundle,
  type Manifest,
  type ManifestFragment,
} from './manifest.ts'
import { activateBundledPlugins, mergeBundledRecords, resolveBundledDependencies } from './bundled.ts'
import type { PiAiManagedProviderSlot } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  alignRelayFragments,
  generateModelRoute,
  hubModelOwnership,
  legacyModelPath,
  readBundledModelSnapshot,
  readLegacyModelOwnership,
  providerServesModel,
  routeProviders,
  withoutModelRows,
  type BundledModelSnapshot,
  type HubDefaultSelection,
  type HubModelOwnership,
} from './models.ts'
import { declaredRowIds, readOverlay, renderOverlay, writeOverlay } from './overlay.ts'
import type { OverlayProxy, OverlayRow } from './overlay.ts'
import { NO_HUB_SEARCH, searchFragments, type HubSessionTools } from './search.ts'
import { buildDeviceReport, type PluginReportEntry, type PluginState } from './report.ts'
import {
  initialState,
  loadState,
  mergeApplyRecord,
  saveState,
  type HubSettings,
  type HubState,
  type ManagedModelRecord,
  type ManagedPluginRecord,
  type PendingRestart,
} from './state.ts'

/** Manifests are small; the client refuses anything larger. */
const MAX_MANIFEST_BYTES = 1024 * 1024

/** The plugin manager surface the connector drives. */
export interface PluginManagerAccess {
  /** Every bundle the profile knows. */
  listBundles(): Promise<readonly InstalledBundle[]>
  /** Install one `file:` spec. */
  installBundle(spec: string, options?: { readonly saveExact?: boolean }): Promise<ChangeOutcome>
  /** Remove one bundle. */
  removeBundle(name: string): Promise<ChangeOutcome>
  /** Select or deselect one bundle. */
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeOutcome>
}

/**
 * Why a restart is pending, as the account page shows it.
 *
 * The record also carries the Host process that wrote it and an optional request
 * from the account page; the desktop shell reads the same record from the state
 * file, because only it can restart the application.
 */
export type RestartNotice = PendingRestart

/** Everything one status read returns to the account page. */
export interface ConnectorStatus {
  /** Whether a device token is stored. */
  readonly signedIn: boolean
  /** Hub origin in effect. */
  readonly hubOrigin: string
  /** Build-baked origin, so the page can offer a reset. */
  readonly builtHubOrigin: string
  /** Account facts, when signed in. */
  readonly user: { readonly username: string; readonly displayName: string; readonly role: 'user' | 'admin'; readonly roleLabel: string } | null
  /** Wallet in micro-points, when the Hub reports one. */
  readonly wallet: { readonly balance: number; readonly unit: 'micro-point' } | null
  /** Device id the Hub issued. */
  readonly deviceId: string | null
  /** Device name in reports. */
  readonly deviceName: string
  /** Applied revision. */
  readonly appliedRevision: number | null
  /** Last application state. */
  readonly applyState: string
  /** Last failure cause. */
  readonly applyErrorCode: string | null
  /** Managed plugins after the last application. */
  readonly managed: readonly ManagedPluginRecord[]
  /** Exact body of the last device report. */
  readonly lastReport: unknown
  /** Pending restart, when one is needed. */
  readonly restart: RestartNotice | null
  /** Last manifest notice. */
  readonly notice: string | null
  /** Authorize URL while a login attempt waits for the browser. */
  readonly loginUrl: string | null
  /** Phase of the current login attempt, when there is one. */
  readonly loginPhase: string | null
  /** Which pilot scopes the Hub serves for this device. */
  readonly agentModes: { readonly claudeCode: boolean; readonly codex: boolean }
  /** Setting: whether the DeepSeek account entry stays available. */
  readonly deepSeekLogin: boolean
}

/** What the connector needs from the Host. */
export interface ConnectorHost {
  /** Desktop profile directory. */
  readonly profile: string
  /** Build identity (version, channel, baked origin, schema location). */
  readonly build: BuildIdentity
  /** Process environment the Host launched with. */
  readonly environment: NodeJS.ProcessEnv
  /** Account host surface (credentials, routes, clock, events). */
  readonly account: AccountHost
  /** Plugin manager, when the profile mounted one. */
  readonly pluginManager?: PluginManagerAccess | undefined
  /** The installer's bundled plugin directory and model snapshot, when this build carries one. */
  readonly bundledDirectory?: string | undefined
  /** The profile's bundled package manager invocation, for resolving plugin dependencies. */
  readonly packageManager?: {
    readonly command: string
    readonly args: readonly string[]
    readonly env: Readonly<Record<string, string>>
  } | undefined
  /** Proxy policy for the overlay's reserved block. */
  readonly proxy?: OverlayProxy | undefined
  /**
   * Identity of this Host process. A restart record written by a different one was
   * already composed into the profile it asked for; tests supply their own value.
   */
  readonly bootId?: string | undefined
  /** Whether a default model is already selected. */
  readonly hasDefaultModel?: (() => Promise<boolean>) | undefined
  /** Select one default model, with the thinking level the snapshot suggests. */
  readonly selectDefaultModel?: ((selection: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }) => Promise<void>) | undefined
}

/** Identity of this Host process, unique per start and stable across recompositions. */
const HOST_BOOT_ID = randomUUID()

/** The shortest interval the Hub may ask for (its own floor is 30 s). */
const MIN_REPORT_INTERVAL_SEC = 30

/** Upper bound the client accepts from the Hub. */
const MAX_REPORT_INTERVAL_SEC = 900

/** How often the manifest is pulled when nothing indicates a change. */
const MANIFEST_IDLE_MS = 10 * 60 * 1000

/** How long to wait when the Hub does not serve the manifest endpoint yet. */
const MANIFEST_UNAVAILABLE_MS = 60 * 60 * 1000

/** How many cached archives to keep. */
const CACHED_ARCHIVES = 4

/** Upper bound for the background dependency install. */
const DEPENDENCY_INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/** The connector. */
export class HubConnector {
  /** Durable state. */
  private state: HubState
  /** Account provider shared with the shell. */
  readonly account: HubAccount
  /** Agent-mode service the pilots inject. */
  readonly agentModes: HubAgentModes
  /** Interval the Hub last asked for. */
  private reportIntervalMs = 60_000
  private reportTimer: ReturnType<typeof setTimeout> | undefined
  private manifestTimer: ReturnType<typeof setTimeout> | undefined
  private reporting = false
  private applying = false
  /** Whether a manifest round trip already owns this instance's application path. */
  private pulling = false
  /** Whether this instance has read the manifest fragments needed to rewrite the overlay. */
  private manifestHydrated = false
  /** Whether the first pass already ran for a signed-in account. */
  private started = false
  /** Whether this instance already applied the installer's bundled plugins. */
  private bundledActivated = false
  /** Whether this instance already started the background dependency pass. */
  private dependenciesStarted = false
  /** The background dependency pass, so the sync round ends after it. */
  private dependencyPass: Promise<void> | undefined
  private readonly listeners = new Set<() => void>()
  /** Search-pool overlay fragments for the session's current `tools` state. */
  private searchFragments: readonly ManifestFragment[] = []
  /** Last search state the session reported (off until the first read). */
  private searchTools: HubSessionTools = NO_HUB_SEARCH
  /** Last manifest notice, for the status card. */
  private notice: string | null = null
  /** Fragments the last applied manifest delivered, so a settings change can re-render the overlay. */
  private lastFragments: readonly ManifestFragment[] = []
  /** Revision the last applied manifest carried. */
  private lastRevision: number | null = null
  /** Last operator notice from a manifest. */
  private lastNotice: string | undefined
  /** Relay addresses already reported, so a repeated delivery does not repeat the warning. */
  private readonly reportedRelayOrigins = new Set<string>()
  /** Cached grant, so the status surface answers without a credential read. */
  private cachedGrant: HubGrant | undefined
  /** The adapter's managed-provider slot, once that service exists in this composition. */
  private modelSlot: PiAiManagedProviderSlot | undefined
  /** Model routes this device currently serves from the Hub, with the default it recommends. */
  private desiredModels: HubModelOwnership | undefined
  /** Why the last delivered model set was refused, when it was; shown on the account card. */
  private modelConflict: string | null = null

  /**
   * @param host - Profile, build identity, plugin manager, and account surface.
   * @param createAccount - Factory producing the account provider bound to this connector.
   */
  constructor(
    private readonly host: ConnectorHost,
    createAccount: (host: AccountHost) => HubAccount,
  ) {
    const fallback = initialState({
      osLabel: host.build.osLabel,
      hubOrigin: host.build.builtHubOrigin,
      installId: host.build.installId,
    })
    this.state = loadState(host.profile, fallback)
    const accountHost: AccountHost = {
      ...host.account,
      hubOrigin: () => this.origin(),
      readState: () => this.state,
      writeState: (next) => { this.persist(next) },
      changed: () => {
        for (const listener of this.listeners) listener()
        host.account.changed()
      },
      sessionTools: (tools) => { this.applySessionTools(tools) },
    }
    this.account = createAccount(accountHost)
    const modesHost: AgentModesHost = {
      hubOrigin: () => this.cachedGrant?.hubOrigin ?? '',
      deviceToken: async () => (await this.syncGrant())?.token ?? '',
      credentials: host.account.credentials,
    }
    this.agentModes = new HubAgentModes(modesHost)
  }

  /** @returns The durable state, read-only. */
  get current(): HubState {
    return this.state
  }

  /**
   * Start the connector: hydrate caches, then run a first heartbeat when signed in.
   * Idempotent; a second call is a no-op.
   * @returns after the first pass settled.
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      // A restart recorded by an earlier Host process is what this start just performed.
      this.retireSatisfiedRestart()
      // The baseline is local, so it lands before any account exists (design §4.2).
      await this.activateBundled()
      // Dependencies the installer cannot lay down resolve after the Host is serving.
      this.dependencyPass = this.resolveDependencies()
      await this.agentModes.hydrate()
      const grant = await this.syncGrant()
      if (grant === undefined) {
        // Signed out: a later call (after a login) is the one that starts the loops.
        this.started = false
        info(`waiting for a DSH Hub login (origin ${this.origin() === '' ? 'unset' : this.origin()})`)
        return
      }
      this.account.startLoops()
      void this.refreshAgentModes()
      // The grant carries the last session's search state, so the rows survive a restart
      // even before the first session poll answers.
      this.applySessionTools(grant.tools ?? NO_HUB_SEARCH)
      // The persisted managed set (or the one an upgraded overlay was migrated into)
      // makes the Hub routes exist before any network answer.
      await this.restoreManagedModels(grant)
      if (this.desiredModels === undefined) await this.ensureModelRoute(grant)
      await this.report()
      await this.pullManifest()
      // The restart decision waits for this round: the dependency pass may need to
      // reload the composition, and a user must not restart into a half-applied profile.
      await this.finishSyncRound()
    } catch (error) {
      this.started = false
      throw error
    }
  }

  /**
   * Drop everything this device derived from the grant: the generated model route
   * and the overlay rows that carry it. The account itself is already signed out.
   */
  clearAfterSignOut(): void {
    // A later sign-in runs the start sequence again: the loops, the persisted Hub
    // routes, and the relay round trip all belong to the signed-in state.
    this.started = false
    this.desiredModels = undefined
    this.modelConflict = null
    this.publishManagedModels()
    this.searchFragments = []
    this.lastFragments = []
    this.lastRevision = null
    this.lastNotice = undefined
    this.manifestHydrated = false
    this.cachedGrant = undefined
    this.notice = null
    this.rewriteOverlay(undefined, true)
    // The overlay the notice referred to is gone, so there is nothing left to restart for.
    if (this.state.restart !== null) this.persist({ ...this.state, restart: null })
    this.notify()
  }

  /** Stop timers and dispose the account provider. */
  stop(): void {
    this.desiredModels = undefined
    this.publishManagedModels()
    if (this.reportTimer !== undefined) clearTimeout(this.reportTimer)
    if (this.manifestTimer !== undefined) clearTimeout(this.manifestTimer)
    this.reportTimer = undefined
    this.manifestTimer = undefined
    this.account.dispose()
    this.listeners.clear()
  }

  /**
   * Record that the account page asked for the pending restart.
   *
   * The connector cannot restart the application; the desktop shell watches this
   * record and runs its own restart path, which stops the Host cleanly and reopens
   * the application. The request lives inside the pending record, so it disappears
   * with it once the restart lands.
   * @returns Whether a pending restart was there to request.
   */
  requestRestart(): boolean {
    if (this.state.restart === null) return false
    const requestedAt = this.host.account.now().toISOString()
    this.persist({ ...this.state, restart: { ...this.state.restart, requestedAt } })
    info('the account page asked for the pending restart; the desktop shell performs it')
    return true
  }

  /**
   * Drop a restart record an earlier Host process wrote.
   *
   * Every Host start composes `cordis.hub.patch.yml`, which is exactly what the
   * notice asked for; keeping the record would prompt for a restart that already
   * happened. A record from this same process survives recompositions.
   */
  private retireSatisfiedRestart(): void {
    const restart = this.state.restart
    if (restart === null || restart.boot === this.bootId()) return
    this.persist({ ...this.state, restart: null })
    info('the pending Hub restart is in effect: this Host start composed the overlay it asked for')
  }

  /** @returns Identity of the running Host process. */
  private bootId(): string {
    return this.host.bootId ?? HOST_BOOT_ID
  }

  /**
   * Settle this instance's background dependency pass, then timestamp the round.
   *
   * The timestamp is what the desktop shell compares with the pending restart: only
   * a sync round that finished (manifest applied, model route and search rows written,
   * dependencies resolved) may raise the prompt.
   */
  private async finishSyncRound(): Promise<void> {
    await this.dependencyPass?.catch((error: unknown) => {
      warn(`bundled dependency pass failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.persist({ ...this.state, syncedAt: this.host.account.now().toISOString() })
  }

  /**
   * Subscribe to state changes for the client surface.
   * @param listener - Called after the state changed.
   * @returns Unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @returns The Hub origin in effect, or '' when none is configured. */
  origin(): string {
    const configured = this.state.settings.hubOrigin.trim() !== '' ? this.state.settings.hubOrigin : this.host.build.builtHubOrigin
    if (configured.trim() === '') return ''
    try {
      return normalizeHubOrigin(configured)
    } catch {
      warn(`the configured Hub origin ${JSON.stringify(configured)} is unusable`)
      return ''
    }
  }

  /** @returns The cached grant, if any (synchronous view for the status surface). */
  get grant(): HubGrant | undefined {
    return this.cachedGrant
  }

  /** Refresh the cached grant from the credential store. */
  private async syncGrant(): Promise<HubGrant | undefined> {
    this.cachedGrant = await this.account.readGrant()
    return this.cachedGrant
  }

  /**
   * Re-read the account snapshot and cached grant, then notify the client.
   * @returns after the snapshot was read.
   */
  async refreshSession(): Promise<void> {
    await this.syncGrant()
    await this.account.refreshSession()
    this.notify()
  }

  /**
   * Apply a settings change and write it to disk.
   * @param patch - Settings members to replace.
   */
  saveSettings(patch: Partial<HubSettings>): void {
    const deepSeekChanged = patch.deepSeekLogin !== undefined && patch.deepSeekLogin !== this.state.settings.deepSeekLogin
    this.persist({
      ...this.state,
      settings: {
        hubOrigin: patch.hubOrigin ?? this.state.settings.hubOrigin,
        deviceName: patch.deviceName ?? this.state.settings.deviceName,
        deepSeekLogin: patch.deepSeekLogin ?? this.state.settings.deepSeekLogin,
      },
    })
    if (patch.hubOrigin !== undefined) void this.syncGrant().then(() => { this.notify() })
    if (deepSeekChanged) {
      // The switch owns the search rows in official-account mode; hand them back when it
      // is off again without waiting for the next session poll.
      this.searchFragments = searchFragments(this.searchTools, { officialAccount: this.state.settings.deepSeekLogin })
      this.rewriteOverlay('deepseek-account-switch')
    }
  }

  /**
   * Re-render the overlay from the last applied manifest, so a settings switch
   * that changes composition rows reaches the file the next Host start reads.
   */
  /**
   * Rewrite the overlay from the last applied manifest plus whatever the connector
   * generated itself (the model route, the account switch). Called after login so a
   * Hub login alone is enough to have working models, and after sign-out so the
   * stale route disappears with the key it referenced.
   */
  /**
   * @param reason - When present, also record the requested restart; absence only writes the overlay.
   * @param withoutManifest - True for sign-out or a Hub without manifests; false waits for this instance to hydrate its fragments.
   */
  private rewriteOverlay(reason?: string, withoutManifest = false): void {
    if (!this.manifestHydrated && !withoutManifest) return
    try {
      const rendered = renderOverlay({
        revision: this.lastRevision,
        fragments: [...withoutModelRows(this.lastFragments), ...this.searchFragments].map(fragment => ({
          id: fragment.id,
          mode: fragment.mode,
          config: fragment.config,
          ...fragment.note === undefined ? {} : { note: fragment.note },
        })),
        connectorRow: true,
        provideAccount: !this.state.settings.deepSeekLogin,
        extraRows: this.accountSwitchRows(),
        ...this.lastNotice === undefined ? {} : { notice: this.lastNotice },
        ...this.host.proxy === undefined ? {} : { proxy: this.host.proxy },
      }, { userDeclared: declaredRowIds(this.readUserPatch()) })
      writeOverlay(this.host.profile, rendered.text)
      // Only a composition change needs a restart; a model-route refresh takes effect
      // the next time the Host composes the profile without the user restarting.
      if (reason !== undefined) {
        this.persist({ ...this.state, restart: { reason, at: this.host.account.now().toISOString(), boot: this.bootId() } })
        info(`the Hub overlay changed (${reason}); it applies on the next start`)
      }
    } catch (error) {
      warn(`could not rewrite the Hub overlay: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Overlay rows of the advanced account switch.
   *
   * The bundle layer disables the upstream account provider and every DeepSeek
   * service a Hub build does not serve. A user who asks for the official account
   * gets the whole set back, because that account is what makes the official model
   * route and the search provider usable; the overlay outranks the bundle layer,
   * so this is the only place the decision lives.
   * @returns Rows to append to the overlay; empty while the Hub provides the account.
   */
  private accountSwitchRows(): readonly OverlayRow[] {
    if (!this.state.settings.deepSeekLogin) return []
    return [
      { id: 'deepseek-account', disabled: false },
      { id: 'llm-deepseek-account', disabled: false },
      { id: 'web-search-deepseek', disabled: false },
      { id: 'web-deepseek-api', disabled: false },
      { id: 'ui-settings-web-search', disabled: false },
    ]
  }

  /**
   * Start the browser login for the account page's sign-in button.
   * @param callbackOrigin - Browser-facing origin of the Host that will receive the callback.
   * @returns after the attempt reached `waiting-browser`.
   */
  async startLogin(callbackOrigin: string): Promise<void> {
    await this.account.startSignIn(
      { version: this.host.build.appVersion, locale: 'zh-CN', timezoneOffsetSeconds: 0 },
      callbackOrigin,
      'desktop',
    )
    // The attempt asks the Hub for an authorize URL in the background; wait for it,
    // so the caller (and the account page) receives the URL instead of "initializing".
    for (let poll = 0; poll < 100; poll += 1) {
      const view = await this.account.getState()
      if (view.attempt === null || view.attempt.phase !== 'initializing') break
      await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    }
    this.notify()
  }

  /** @returns The status document the account page renders. */
  async status(): Promise<ConnectorStatus> {
    const grant = await this.syncGrant()
    const view = await this.account.getState()
    return {
      signedIn: grant !== undefined,
      hubOrigin: this.origin(),
      builtHubOrigin: this.host.build.builtHubOrigin,
      user: grant?.user ?? null,
      wallet: grant?.wallet ?? null,
      deviceId: grant?.deviceId ?? this.state.deviceId,
      deviceName: this.state.settings.deviceName,
      appliedRevision: this.state.appliedRevision,
      applyState: this.state.applyState,
      applyErrorCode: this.state.applyErrorCode,
      managed: this.state.managed,
      lastReport: this.state.lastReport,
      restart: this.state.restart,
      notice: this.modelConflict === null
        ? this.notice
        : [this.notice ?? '', this.modelConflict].filter(text => text !== '').join(' '),
      deepSeekLogin: this.state.settings.deepSeekLogin,
      loginUrl: view.attempt?.authorizeUrl ?? null,
      loginPhase: view.attempt?.phase ?? null,
      agentModes: {
        claudeCode: this.agentModes.available('claude-code'),
        codex: this.agentModes.available('codex'),
      },
    }
  }

  /**
   * Send one heartbeat and react to the revision the Hub names.
   * @returns after the request settled.
   */
  async report(): Promise<void> {
    if (this.reporting) return
    const grant = await this.syncGrant()
    if (grant === undefined) return
    this.reporting = true
    try {
      const body = buildDeviceReport({
        reportedAt: this.host.account.now().toISOString(),
        appVersion: this.host.build.appVersion,
        appChannel: this.host.build.appChannel,
        runtimeVersion: this.host.build.runtimeVersion,
        appliedRevision: this.state.appliedRevision,
        appliedAt: this.state.appliedAt,
        applyState: this.state.applyState,
        applyErrorCode: this.state.applyErrorCode,
        errorCount: this.state.errorCount,
        plugins: await this.pluginReport(),
      })
      const response = await hubRequest<{
        serverTime: string
        reportIntervalSec: number
        presence: string
        desiredRevision: number | null
      }>({ url: `${grant.hubOrigin}/api/desktop/devices/report`, method: 'POST', token: grant.token, body })
      this.persist({ ...this.state, lastReport: body })
      const interval = response.body?.reportIntervalSec
      if (typeof interval === 'number') {
        this.reportIntervalMs = Math.min(Math.max(interval, MIN_REPORT_INTERVAL_SEC), MAX_REPORT_INTERVAL_SEC) * 1000
      }
      const desired = response.body?.desiredRevision
      if (typeof desired === 'number' && desired !== this.state.appliedRevision) void this.pullManifest()
    } catch (error) {
      if (isDeviceTokenInvalid(error)) warn('the Hub rejected this device token; the account signs out and keeps local sessions')
      else warn(`heartbeat failed (${error instanceof HubRequestError ? error.code : 'network'})`)
    } finally {
      this.reporting = false
      this.scheduleReport()
    }
  }

  /** Arm the next heartbeat at the interval the Hub asked for. */
  private scheduleReport(): void {
    if (this.reportTimer !== undefined) clearTimeout(this.reportTimer)
    this.reportTimer = setTimeout(() => { void this.report() }, this.reportIntervalMs)
    this.reportTimer.unref?.()
  }

  /** Whether the last application failed in a way a retry can fix without a new revision. */
  private applyNeedsRetry(): boolean {
    return this.state.applyState === 'failed' || this.state.applyErrorCode === 'config_write_failed'
  }

  /**
   * Pull and apply the manifest when the Hub has a newer revision.
   * @returns after the round trip settled.
   */
  async pullManifest(): Promise<void> {
    // One round trip at a time: the heartbeat and the login sync both ask for the
    // manifest, and two applications of one revision would record two restart notices.
    if (this.applying || this.pulling) return
    this.pulling = true
    try {
      await this.pullManifestOnce()
    } finally {
      this.pulling = false
    }
  }

  /** The body of one manifest pull, serialized by {@link pullManifest}. */
  private async pullManifestOnce(): Promise<void> {
    const grant = await this.syncGrant()
    if (grant === undefined) return
    this.state = mergeApplyRecord(this.state, loadState(this.host.profile, this.state))
    const fetched = await this.fetchManifest(grant)
    if (this.applying) return
    if (fetched === 'not-supported') {
      // A Hub build without the search-overlay endpoint answers 404; nothing to apply, so back off.
      this.rewriteOverlay(undefined, true)
      this.scheduleManifest(MANIFEST_UNAVAILABLE_MS)
      return
    }
    if (fetched === undefined) {
      this.scheduleManifest(MANIFEST_IDLE_MS)
      return
    }
    const appliedRevision = this.state.appliedRevision ?? 0
    // A failed application is retried on the next pull even when the Hub still
    // names the same revision: the refusal is usually a conflict the user just
    // resolved, and waiting for another revision would need an operator change.
    const retry = this.applyNeedsRetry()
    if (fetched === 'unchanged' || fetched.revision < appliedRevision
      || (fetched.revision === appliedRevision && this.manifestHydrated && !retry && this.state.pendingRemovals.length === 0)) {
      this.scheduleManifest(MANIFEST_IDLE_MS)
      return
    }
    await this.applyFetchedManifest(fetched, grant)
    this.scheduleManifest(MANIFEST_IDLE_MS)
  }

  /** Fetch and validate the manifest body. */
  private async fetchManifest(grant: HubGrant): Promise<Manifest | 'unchanged' | 'not-supported' | undefined> {
    try {
      const response = await hubRequest<unknown>({
        url: `${grant.hubOrigin}/api/desktop/manifest`,
        token: grant.token,
        ...!this.manifestHydrated || this.state.manifestEtag === null || this.state.pendingRemovals.length > 0
          || this.applyNeedsRetry()
          ? {} : { headers: { 'if-none-match': this.state.manifestEtag } },
      })
      if (response.status === 304) return 'unchanged'
      if (Buffer.byteLength(JSON.stringify(response.body ?? null)) > MAX_MANIFEST_BYTES) {
        warn('the Hub manifest exceeds the client cap; refusing it')
        this.persist({ ...this.state, applyState: 'failed', applyErrorCode: 'manifest_invalid', errorCount: 1 })
        return undefined
      }
      const validation = validateManifest(response.body, {
        schema: loadManifestSchema(this.host.build.schemaDirectory),
        dshVersion: this.host.build.appVersion,
        deviceId: this.state.deviceId,
      })
      for (const warning of validation.warnings) warn(warning)
      if (!validation.ok) {
        const first = validation.issues[0]
        warn(`the Hub manifest is invalid${first === undefined ? '' : ` (${first.path}: ${first.message})`}`)
        this.persist({ ...this.state, applyState: 'failed', applyErrorCode: 'manifest_invalid', errorCount: validation.issues.length })
        return undefined
      }
      if (response.etag !== undefined) this.persist({ ...this.state, manifestEtag: response.etag })
      return validation.manifest
    } catch (error) {
      if (error instanceof HubRequestError && (error.status === 404 || error.code === 'NOT_FOUND')) return 'not-supported'
      warn(`manifest pull failed (${error instanceof HubRequestError ? error.code : 'network'})`)
      return undefined
    }
  }

  /** Apply one validated manifest, then report the outcome. */
  private async applyFetchedManifest(manifest: Manifest, grant: HubGrant): Promise<void> {
    this.applying = true
    try {
      this.notice = manifest.notice ?? null
      const cacheRoot = `${this.host.profile}/desktop-hub/cache`
      const manager = this.host.pluginManager
      // A fragment rendered for a container can name the relay's internal listener,
      // which this device cannot route; move it to the Hub this device signed in to.
      const aligned = alignRelayFragments(manifest.config.fragments, grant.hubOrigin)
      this.reportRelayRewrites(aligned.rewrites)
      // The model rows leave the overlay: the adapter registers the delivered routes
      // as a managed set, so the profile patch the Models page writes stays the only
      // owner of the user's own configuration.
      const owned = hubModelOwnership(aligned.fragments)
      const delivered = { ...manifest, config: { ...manifest.config, fragments: withoutModelRows(aligned.fragments) } }
      this.lastFragments = delivered.config.fragments
      this.lastRevision = manifest.revision
      this.lastNotice = manifest.notice
      // Refusing a Model set must not report the whole manifest as applied; the
      // previous routes and the user's configuration keep serving.
      const modelsApplied = owned === undefined ? true : this.adoptManagedModels(owned, grant)
      if (modelsApplied && owned?.defaultSelection !== undefined) {
        await this.applyHubDefaultModel(owned.defaultSelection, owned)
      }
      const previousManaged = this.state.managed
      const outcome = await applyManifest(delivered, {
        listBundles: async () => (manager === undefined ? [] : await manager.listBundles()),
        install: async (spec, options) => (manager === undefined
          ? { changed: false, error: 'no-plugin-manager' }
          : await manager.installBundle(spec, options)),
        remove: async name => (manager === undefined
          ? { changed: false, error: 'no-plugin-manager' }
          : await manager.removeBundle(name)),
        setEnabled: async (name, enabled) => (manager === undefined
          ? { changed: false, error: 'no-plugin-manager' }
          : await manager.setBundleEnabled(name, enabled)),
        fetchArtifact: async (artifact: ArtifactRef) => downloadArtifact(artifact, cacheRoot, await this.artifactDownloadOptions()),
        readUserPatch: () => this.readUserPatch(),
        writeOverlay: (text) => { writeOverlay(this.host.profile, text) },
        readOverlay: () => readOverlay(this.host.profile),
        extraFragments: () => [...this.searchFragments],
        extraRows: () => this.accountSwitchRows(),
        connectorProvidesAccount: !this.state.settings.deepSeekLogin,
        ...this.host.proxy === undefined ? {} : { proxy: this.host.proxy },
        dshVersion: this.host.build.appVersion,
        previousManaged,
        profile: this.host.profile,
      })
      pruneCache(cacheRoot, CACHED_ARCHIVES)
      this.manifestHydrated = true
      // A bundled package the manifest explicitly uninstalls stays out of the baseline
      // until a manifest names it again; otherwise the next start would reinstall it.
      const suppressed = new Set(this.state.bundledRemovals.filter(name => !manifest.plugins.some(plugin => plugin.name === name)))
      for (const name of manifest.uninstall) {
        if (previousManaged.some(entry => entry.name === name && entry.source === 'bundled')) suppressed.add(name)
      }
      this.persist({
        ...this.state,
        applySequence: Math.max(this.state.applySequence, loadState(this.host.profile, this.state).applySequence) + 1,
        appliedRevision: manifest.revision,
        appliedAt: this.host.account.now().toISOString(),
        applyState: modelsApplied ? outcome.applyState : outcome.applyState === 'failed' ? 'failed' : 'partial',
        applyErrorCode: modelsApplied ? outcome.errorCode : outcome.errorCode ?? 'config_write_failed',
        errorCount: outcome.errorCount + (modelsApplied ? 0 : 1),
        managed: outcome.managed,
        pendingRemovals: outcome.pendingRemovals,
        bundledRemovals: [...suppressed],
        restart: this.nextRestart(outcome.restartReason),
      })
      info(`applied Hub manifest revision ${String(manifest.revision)} (${outcome.applyState})`)
      // A delivery without the model rows leaves the relay-derived route (or the
      // persisted set) in service; when it names models, those already replaced it.
      if (owned === undefined) await this.ensureModelRoute(grant, true)
      // A manifest pulled outside the login sync still owns a restart prompt. The round
      // ends off this path: a background dependency install can run for minutes, and
      // holding `applying` that long would skip the next revision the Hub announces.
      void this.finishSyncRound()
      this.notify()
      void this.report()
    } catch (error) {
      warn(`manifest application failed: ${error instanceof Error ? error.message : String(error)}`)
      this.persist({ ...this.state, applyState: 'failed', applyErrorCode: 'unknown', errorCount: 1 })
    } finally {
      this.applying = false
    }
  }

  /**
   * Decide the pending-restart record one application leaves behind.
   *
   * The same need recorded twice in one Host process keeps its original timestamp: a
   * duplicate application of one delivery, or a later revision that still only needs the
   * restart already offered, must not raise a second prompt. A different reason is a new
   * record, and the shell offers it again.
   * @param reason - Restart reason the application produced, or null when it needs none.
   * @returns The record to persist.
   */
  private nextRestart(reason: string | null): PendingRestart | null {
    const pending = this.state.restart
    if (reason === null) return this.state.pendingRemovals.length > 0 ? null : pending
    const sameProcess = pending !== null && pending.boot === this.bootId() && pending.reason === reason
    return {
      reason,
      at: sameProcess ? pending.at : this.host.account.now().toISOString(),
      boot: this.bootId(),
      ...sameProcess && pending.requestedAt !== undefined ? { requestedAt: pending.requestedAt } : {},
    }
  }

  /** Arm the next manifest pull. */
  private scheduleManifest(delay: number): void {
    if (this.manifestTimer !== undefined) clearTimeout(this.manifestTimer)
    this.manifestTimer = setTimeout(() => { void this.pullManifest() }, delay)
    this.manifestTimer.unref?.()
  }

  /**
   * Apply the Hub search-pool state to the overlay.
   *
   * The account provider calls this after every `GET /api/desktop/session` read and
   * with "off" on sign-out or a rejected device token, so the served search endpoint
   * follows the Hub switch without a restart prompt. The rows are `enforce`: search
   * calls are metered by the Hub wallet, so the Hub-side decision has to win over a
   * stale profile edit. In official-account mode the switch owns those rows and this
   * method renders nothing.
   * @param tools - Normalized `tools` member of the session response.
   */
  private applySessionTools(tools: HubSessionTools): void {
    this.searchTools = tools
    const next = searchFragments(tools, { officialAccount: this.state.settings.deepSeekLogin })
    if (JSON.stringify(next) === JSON.stringify(this.searchFragments)) return
    this.searchFragments = next
    // No restart prompt: like the model route, the overlay reaches the composition on the
    // next Host start (the shell already recomposes when the file changes).
    this.rewriteOverlay()
    this.notify()
    info(next.length === 0
      ? 'the Hub search pool is off; the overlay serves no web provider'
      : `the Hub search pool is on; the overlay points the web provider at ${tools.baseUrl ?? ''}`)
  }

  /**
   * Load the Hub model list and synthesize the managed route when no manifest delivered one.
   * @param grant - Current device grant.
   * @param force - Replace a persisted set as well (a delivery stopped naming model rows).
   */
  private async ensureModelRoute(grant: HubGrant, force = false): Promise<void> {
    if (this.host.pluginManager === undefined) return
    const key = await this.relayKey()
    if (key === undefined) return
    const route = await generateModelRoute(grant.hubOrigin, key, this.bundledModels())
    if (route === undefined) return
    const providers = routeProviders(route.fragment.config)
    if (providers === undefined) return
    const next: HubModelOwnership = {
      providers,
      ...route.defaultSelection.model === '' ? {} : { defaultSelection: route.defaultSelection },
    }
    if (!force && this.desiredModels !== undefined) return
    if (!this.adoptManagedModels(next, grant)) return
    if (route.defaultSelection.model === '') return
    await this.applyHubDefaultModel(route.defaultSelection, next)
  }

  /**
   * Attach the adapter's managed-provider slot, and replay whatever this device
   * already owns. The composition mounts the adapter independently, so the slot can
   * appear after this connector (or again after the adapter reloads).
   * @param slot - The adapter's contribution slot, or undefined when that service is gone.
   */
  attachManagedProviderSlot(slot: PiAiManagedProviderSlot | undefined): void {
    if (this.modelSlot === slot) return
    const previous = this.modelSlot
    this.modelSlot = slot
    if (previous !== undefined) {
      // The connector that owned the previous slot is going away (or the adapter
      // reloaded): its routes must not outlive it even if its scope was torn down
      // without a sign-out.
      try { previous.withdraw() } catch (error) {
        warn(`the previous model slot could not be withdrawn: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (slot !== undefined) this.publishManagedModels()
  }

  /**
   * Restore the Hub model routes this profile already carries.
   *
   * An upgraded install still has the rows inside `cordis.hub.patch.yml`; the
   * desktop Host strips them at the next start and leaves the extracted set in
   * `desktop-hub/legacy-models.json`, which this method imports once and removes.
   */
  private async restoreManagedModels(grant: HubGrant): Promise<void> {
    let stored: ManagedModelRecord | null = this.state.managedModels
    if (stored === null) {
      try {
        const legacy = readLegacyModelOwnership(this.host.profile)
        if (legacy !== undefined) {
          stored = {
            providers: legacy.providers,
            origin: grant.hubOrigin,
            deviceId: grant.deviceId,
            ...legacy.defaultSelection === undefined ? {} : { defaultSelection: legacy.defaultSelection },
          }
          this.persist({ ...this.state, managedModels: stored })
          rmSync(legacyModelPath(this.host.profile), { force: true })
          info('imported the model routes an earlier desktop overlay owned')
        }
      } catch (error) {
        warn(`the migrated model file is unusable and stays in place: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (stored === null) return
    // A set delivered by another Hub or another device/account is not republished:
    // its routes and credential reference belong to that identity, and the Hub
    // will deliver this account's set on the next sync.
    if (stored.origin !== grant.hubOrigin || stored.deviceId !== grant.deviceId) {
      warn('the cached Hub model set belongs to another Hub or account; waiting for this device\'s delivery')
      return
    }
    this.desiredModels = {
      providers: stored.providers,
      ...stored.defaultSelection === undefined ? {} : { defaultSelection: stored.defaultSelection },
    }
    this.publishManagedModels()
    await this.applyHubDefaultModel(stored.defaultSelection, this.desiredModels)
  }

  /**
   * Replace the Hub model routes this device serves and remember them.
   * @param next - Routed providers and the default the Hub recommends.
   * @returns False when the adapter refused the set; the previous one keeps serving.
   */
  private adoptManagedModels(next: HubModelOwnership, grant: HubGrant): boolean {
    const previous = this.desiredModels
    this.desiredModels = next
    if (!this.publishManagedModels()) {
      this.desiredModels = previous
      return false
    }
    const record: ManagedModelRecord = {
      providers: next.providers,
      origin: grant.hubOrigin,
      deviceId: grant.deviceId,
      ...next.defaultSelection === undefined ? {} : { defaultSelection: next.defaultSelection },
    }
    const stored = this.state.managedModels
    if (JSON.stringify(previous) !== JSON.stringify(next) || stored?.origin !== record.origin
      || stored?.deviceId !== record.deviceId) {
      this.persist({ ...this.state, managedModels: record })
    }
    return true
  }

  /**
   * Hand the current set to the adapter, or withdraw it.
   * @returns False when the adapter refused the set, with the reason kept for the account card.
   */
  private publishManagedModels(): boolean {
    const slot = this.modelSlot
    const desired = this.desiredModels
    if (slot === undefined) return true
    try {
      if (desired === undefined) slot.withdraw()
      else slot.replace(desired.providers)
      if (this.modelConflict !== null) {
        this.modelConflict = null
        this.notify()
      }
      return true
    } catch (error) {
      this.modelConflict = error instanceof Error ? error.message : String(error)
      warn(`the Hub model routes were refused: ${this.modelConflict}`)
      this.notify()
      return false
    }
  }

  /**
   * Adopt the Hub's recommended default only while the user has chosen nothing.
   *
   * A user's pick is written to the profile patch; the recommendation must never
   * overwrite it, on a later sync or at the next start.
   * @param selection - Provider, model, and optional level the delivery names.
   * @param owned - The managed set the selection must belong to, when it is known.
   */
  private async applyHubDefaultModel(selection: HubDefaultSelection | undefined, owned: HubModelOwnership | undefined): Promise<void> {
    if (selection === undefined || selection.model === '') return
    const { hasDefaultModel, selectDefaultModel } = this.host
    if (hasDefaultModel === undefined || selectDefaultModel === undefined) return
    const providers = owned?.providers ?? {}
    if (Object.hasOwn(providers, selection.provider) && !providerServesModel(providers[selection.provider], selection.model)) {
      warn(`the Hub recommends ${selection.provider}/${selection.model}, which its own model set does not serve; keeping the current default`)
      return
    }
    try {
      if (await hasDefaultModel()) return
      await selectDefaultModel(selection)
    } catch (error) {
      warn(`could not adopt the Hub default model: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Resolve bundled plugin dependencies in the background, then reload once (design §4.2).
   *
   * The installer extracts the archives before the Host starts, which cannot
   * materialise a plugin's own dependencies (the pilots fetch their SDK and
   * platform binaries that way). Doing that here keeps the first window fast;
   * one composition reload follows a successful install so both pilots activate
   * together, and a failure is retried on the next start.
   */
  private async resolveDependencies(): Promise<void> {
    const manager = this.host.pluginManager
    if (this.dependenciesStarted || manager === undefined) return
    this.dependenciesStarted = true
    try {
      await resolveBundledDependencies({
        profile: this.host.profile,
        records: this.state.managed,
        install: async () => await this.installProfileDependencies(),
        reload: async () => {
          const first = this.state.managed.find(record => record.source === 'bundled' && record.enabled)
          if (first === undefined) return
          // Selecting an already selected bundle is a no-op, but the call still
          // recomposes the profile once, which activates every bundle whose
          // dependency now exists.
          await manager.setBundleEnabled(first.name, true)
        },
      })
    } catch (error) {
      warn(`could not resolve bundled plugin dependencies: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Run the profile's bundled package install.
   * @returns True when the install exited successfully.
   */
  private async installProfileDependencies(): Promise<boolean> {
    const runner = this.host.packageManager
    if (runner === undefined) {
      warn('this profile has no bundled package manager; bundled plugin dependencies stay unresolved')
      return false
    }
    try {
      const child = spawn(runner.command, [...runner.args, 'install', '--prefer-offline'], {
        cwd: this.host.profile,
        env: { ...process.env, ...runner.env },
        stdio: 'ignore',
        windowsHide: true,
      })
      const timer = setTimeout(() => { child.kill() }, DEPENDENCY_INSTALL_TIMEOUT_MS)
      const code = await new Promise<number | null>((resolve) => {
        child.once('error', () => { resolve(null) })
        child.once('exit', (status) => { resolve(status) })
      })
      clearTimeout(timer)
      if (code !== 0) warn(`the profile package install exited with ${code === null ? 'an error' : String(code)}`)
      return code === 0
    } catch (error) {
      warn(`the profile package install could not start: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Read the installer's model snapshot, if this build carries one.
   * @returns The snapshot, or undefined when absent or unreadable.
   */
  private bundledModels(): BundledModelSnapshot | undefined {
    const directory = this.host.bundledDirectory
    if (directory === undefined) return undefined
    try {
      return readBundledModelSnapshot(directory)
    } catch (error) {
      warn(`the bundled model snapshot is unusable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * Install or upgrade the installer's bundled plugins (design §4.2).
   *
   * Runs before the sign-in gate: the archives ship inside the installer, so a
   * first start has them whether or not the device ever reaches the Hub. Per-run
   * guard: a later sign-in on the same instance does not repeat the work.
   */
  private async activateBundled(): Promise<void> {
    const directory = this.host.bundledDirectory
    const manager = this.host.pluginManager
    if (this.bundledActivated || directory === undefined || manager === undefined) return
    this.bundledActivated = true
    try {
      const outcome = await activateBundledPlugins({
        directory,
        profile: this.host.profile,
        listBundles: async () => manager.listBundles(),
        install: async (spec, options) => manager.installBundle(spec, options),
        setEnabled: async (name, enabled) => manager.setBundleEnabled(name, enabled),
        suppressed: this.state.bundledRemovals,
      })
      const managed = mergeBundledRecords(this.state.managed, outcome.records, new Set(outcome.declared))
      if (JSON.stringify(managed) !== JSON.stringify(this.state.managed)) this.persist({ ...this.state, managed })
      if (outcome.failures > 0) warn(`${String(outcome.failures)} bundled plugin(s) could not be installed`)
      if (outcome.restartReason !== null) info(outcome.restartReason)
    } catch (error) {
      warn(`could not apply the installer's bundled plugins: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Credentials for an artifact download.
   *
   * The Hub's plugin download requires this device's bearer token. It is offered only
   * to the Hub origin — `downloadArtifact` compares origins and sends nothing anywhere
   * else, so a manifest naming a third-party host still downloads anonymously.
   * @returns Empty when signed out; the token never reaches the log.
   */
  private async artifactDownloadOptions(): Promise<ArtifactDownloadOptions> {
    const origin = this.origin()
    const token = (await this.syncGrant())?.token ?? ''
    if (origin === '' || token === '') return {}
    return { authorization: { origin, token } }
  }

  /**
   * Log one line per relay address this device could not have used.
   *
   * A manifest revision is applied once, but a recomposition constructs this
   * plugin again, so the set keeps a repeated delivery from repeating the warning.
   * @param rewrites - Providers whose base URL moved to this device's Hub.
   */
  private reportRelayRewrites(rewrites: readonly { readonly provider: string; readonly from: string; readonly to: string }[]): void {
    for (const rewrite of rewrites) {
      const key = `${rewrite.provider} ${rewrite.from}`
      if (this.reportedRelayOrigins.has(key)) continue
      this.reportedRelayOrigins.add(key)
      warn(`the Hub delivered ${rewrite.provider}.baseURL ${rewrite.from}, which this device cannot reach; using ${rewrite.to}`)
    }
  }

  /** Resolve the device's relay key from the credential store. */
  private async relayKey(): Promise<string | undefined> {
    const value = (await this.host.account.credentials.resolve(HUB_RELAY_REF))?.value
    return value === undefined || value === '' ? undefined : value
  }

  /** Read the profile's own patch text. */
  private readUserPatch(): string {
    try {
      return readFileSync(`${this.host.profile}/cordis.patch.yml`, 'utf8')
    } catch {
      return ''
    }
  }

  /** Ask the Hub for both mode keys in the background. */
  private async refreshAgentModes(): Promise<void> {
    await this.agentModes.hydrate()
    for (const scope of ['claude-code', 'codex'] as const) void this.agentModes.refresh(scope)
  }

  /** Project the managed set and live bundles onto report entries. */
  private async pluginReport(): Promise<PluginReportEntry[]> {
    const installed = this.host.pluginManager === undefined ? [] : await this.host.pluginManager.listBundles()
    const byName = new Map(installed.map(bundle => [bundle.name, bundle]))
    return this.state.managed.map((entry) => {
      const bundle = byName.get(entry.name)
      const state: PluginState = bundle === undefined
        ? 'absent'
        : bundle.error !== undefined ? 'failed' : bundle.enabled ? 'enabled' : 'disabled'
      return {
        name: entry.name,
        version: entry.version,
        source: entry.source,
        state,
        ...state === 'failed' ? { errorCode: 'plugin_install_failed' } : {},
      }
    })
  }

  /** Persist one state document and notify listeners. */
  private persist(next: HubState): void {
    // A recomposition constructs a second connector while this one runs, so the
    // file may already hold a later application than this snapshot does.
    const merged = mergeApplyRecord(next, loadState(this.host.profile, next))
    this.state = merged
    try {
      saveState(this.host.profile, merged)
    } catch (error) {
      warn(`could not write the connector state: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.notify()
  }

  /** Notify every client listener. */
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A listener is a UI callback; a failure there must not break the connector.
      }
    }
  }
}
