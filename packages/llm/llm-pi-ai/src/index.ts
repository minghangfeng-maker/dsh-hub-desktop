/**
 * Generic pi-ai-backed LLM adapter plugin. One plugin instance owns a dict of
 * provider routes; a route naming an installed pi-ai provider inherits that
 * provider's endpoint, protocol, and model catalog as defaults, and a route
 * pi-ai does not ship is declared outright. Profile facts resolve per request
 * over the optional `llm-pi-ai` user-settings section and the optional
 * credential seam, so a changed key, endpoint, model, or knob reaches the next
 * request without a restart; a changed *route set* (or a route's
 * registration-captured retry policy) re-registers the same adapter instance
 * in place.
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config:
 *     providers:
 *       # Catalog route: everything but the credential comes from pi-ai.
 *       openai:
 *         apiKeyEnv: OPENAI_API_KEY
 *         retryPolicy:
 *           mode: normal
 *           maxRetries: 2
 *       # Catalog route with the catalog narrowed and one capacity corrected.
 *       anthropic:
 *         apiKeyEnv: ANTHROPIC_API_KEY
 *         models:
 *           - id: claude-sonnet-4-5
 *             contextWindow: 200000
 *       # Hand-declared route: pi-ai ships nothing under this key.
 *       acme-gateway:
 *         displayName: Acme Gateway
 *         apiKeyEnv: ACME_GATEWAY_API_KEY
 *         api: openai-completions
 *         baseURL: https://gateway.acme.example/v1
 *         # Reasoning dialect for a URL pi-ai cannot recognize.
 *         compat:
 *           thinkingFormat: deepseek
 *         models:
 *           - id: acme-large
 *             name: Acme Large
 *             contextWindow: 65536
 *             maxTokens: 4096
 *           - id: acme-think
 *             name: Acme Think
 *             contextWindow: 262144
 *             maxTokens: 32768
 *             # key = selectable level, value = wire spelling; only off may
 *             # leave the value empty (supported, send nothing).
 *             reasoningEfforts:
 *               off:
 *               high: high
 *               max: ultra
 * ```
 *
 * @module @deepseek-ai/dsh-llm-pi-ai
 */
import type {} from '@deepseek-ai/dsh-settings'

import type {} from '@deepseek-ai/cordis-plugin-loader'

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { PiAiAdapter } from './adapter.ts'
import { authContextFrom, credentialStoreFrom } from './auth.ts'
import { catalogProvider, catalogProviderIds } from './catalog.ts'
import { assertServiceable, Config, resolveProfiles } from './config.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { discoverModels } from './discovery.ts'
import type { StoredModelDiscoveryProfile } from './discovery.ts'
import { registerPiAiFlows } from './login.ts'
import { PiAiManagedProviderRegistry } from './managed.ts'
import type { ManagedProvidersSnapshot } from './managed.ts'
import { providerDefaultsOf } from './provider-data.ts'

export { PiAiAdapter } from './adapter.ts'
export type { PiAiAdapterOptions } from './adapter.ts'
export { Config } from './config.ts'
export type {
  Options,
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiProviderProfile,
  PiAiReasoningEfforts,
  PiAiThinkingFormat,
  ResolvedPiAiProviderProfile,
} from './config.ts'
export { recordKeyFor } from './auth.ts'
export { PiAiManagedProviderRegistry } from './managed.ts'
export type { ManagedProvidersSnapshot, PiAiManagedProviderSlot, PiAiManagedProviders } from './managed.ts'
export { supportedProtocols } from './provider.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Provider routes another plugin owns on this adapter's behalf, so Hub-managed
     * model routes and the user's own routes serve side by side without the Hub
     * owning the user's configuration section.
     */
    llmPiAiManaged: import('./managed.ts').PiAiManagedProviders
  }
}

export const name = 'llm-pi-ai'
export const inject = ['llm']

const NS = 'llm-pi-ai'

/**
 * The registry captures these per route; a change here must re-register.
 * Sorted by provider so a settings document that merely reorders its keys is
 * not mistaken for a route change.
 */
function registrationFacts(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): unknown {
  return [...profiles.entries()]
    // `displayName` rides along because the registry hands it to every selector
    // through `providerInfo()`: a rename that did not re-register would leave
    // the old label showing until some unrelated fact happened to change.
    .map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName,
      retryPolicy: profile.retryPolicy,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * The configurable-provider directory: every installed catalog route, plus
 * every route the current profiles declare. A hand-declared route has no
 * catalog entry, so without this union it would have no settings address and
 * configuration surfaces could neither show nor edit it. A catalog route also
 * carries its catalog endpoint and native authentication, which a settings
 * editor shows while the profile leaves the endpoint or the credential
 * reference unset.
 * @param profiles - the currently resolved provider profiles.
 * @returns the directory entries in catalog order, declared routes last.
 */
function directoryEntries(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  settingsNs: string,
  managedRoutes: ReadonlySet<string>,
): LlmConfigurableProvider[] {
  const entries = new Map<string, LlmConfigurableProvider>()
  const declare = (provider: string, displayName: string, error?: string): void => {
    const installed = catalogProvider(provider)
    entries.set(provider, {
      provider,
      displayName,
      settingsNs,
      settingsPath: ['providers', provider],
      // Membership of the installed catalog, not of the settings document:
      // narrowing a shipped provider's models stores a profile too, and that
      // route is still one pi-ai knows.
      declared: installed === undefined,
      ...managedRoutes.has(provider) ? { managed: true } : {},
      ...installed === undefined ? {} : providerDefaultsOf(installed),
      ...error === undefined ? {} : { error },
    })
  }
  for (const provider of catalogProviderIds()) declare(provider, provider)
  for (const [provider, profile] of profiles) declare(provider, profile.displayName, profile.catalogError)
  return [...entries.values()]
}

/** Register one generic pi-ai adapter for all configured provider routes. */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const settingsNs = ctx.fiber.entry?.options.id ?? NS
  /** Routes the user's own configuration section declares, as the registry sees them. */
  const personalRoutes = (): ReadonlySet<string> => new Set(Object.keys(config.providers.get()))
  /**
   * Managed routes another plugin contributes (the desktop Hub). Every change is
   * applied through {@link applyProspective}, which registers the merged route set
   * and directory entries as one transaction, so a candidate the live registry
   * cannot serve leaves the previous sets serving.
   */
  const managed = new PiAiManagedProviderRegistry(
    personalRoutes,
    (snapshot, options) => { applyProspective(snapshot, options) },
  )
  let lastRaw: ReturnType<Config['providers']['get']> | undefined
  let lastManagedRevision = -1
  let memoized: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  /**
   * The resolved profiles for the current configuration and managed set, memoized
   * by both snapshots' identities — which is also what makes the adapter's own
   * snapshot stable across operations that observe no change.
   *
   * Catalog diagnostics stay in the snapshot beside serviceable models, so
   * stored configuration remains visible after an installed catalog changes.
   * Scalar configuration errors still reject resolution.
   */
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const raw = config.providers.get()
    const contributed = managed.snapshot()
    if (raw === lastRaw && contributed.revision === lastManagedRevision && memoized !== undefined) return memoized
    // Conflict rules keep the two sets disjoint, so a managed route never shadows
    // one the user owns; the merge is only how both reach one registration.
    const merged = { ...structuredClone(raw) as import('./config.ts').Options['providers'], ...contributed.providers }
    const next = resolveProfiles(merged, 'deferred')
    lastRaw = raw
    lastManagedRevision = contributed.revision
    memoized = next
    return next
  }
  profiles()
  ctx.on('internal/config', function (this: import('@deepseek-ai/cordis').Fiber, _raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    const candidate = Config(raw as import('./config.ts').Options)
    assertServiceable(
      { providers: structuredClone(candidate.providers.get()) } as import('./config.ts').Options,
      { providers: structuredClone(config.providers.get()) } as import('./config.ts').Options,
    )
    // A personal route may not take over a route the Hub already serves: the
    // user's request must never be answered by the Hub after a silent swap.
    const managedRoutes = managed.snapshot().routes
    for (const [route, profile] of Object.entries(candidate.providers.get())) {
      if (!managedRoutes.has(route)) continue
      if (deepEqualJson(profile, config.providers.get()[route])) continue
      throw new Error(
        `llm-pi-ai: provider route "${route}" is managed by another source (the Hub);`
        + ' choose a different route key for this provider',
      )
    }
    return raw
  })

  const resolveApiKey = async (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv
    // Only a profile that names no credential at all defers to pi-ai's
    // provider-native discovery. Once one is named, a miss must fail loud:
    // handing pi-ai `undefined` would let it pick up an unrelated ambient key
    // (OPENAI_API_KEY and friends), billing another tenant for a request the
    // deployment meant to authenticate differently.
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      // Without the seam the environment is the whole credential plane.
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-pi-ai', ref)
    throw new LlmError(
      `llm-pi-ai: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not`
      + ` set — store ${ref} through the credentials service (the web Models page writes it) or export it,`
      + ' and remove apiKeyEnv only if this provider should authenticate from pi-ai\'s own environment discovery',
      'MISSING_CREDENTIAL',
    )
  }

  // One store and one ambient context for the whole plugin instance: both read
  // through `ctx` per call, so they stay correct across the collection rebuilds
  // a configuration change causes, and a sign-in survives one.
  const auth = { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) }
  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    auth,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `llm-pi-ai: unusable replay state on assistant history for route "${provider}/${model}";`
        + ` sending that message as provider-neutral content (${reason})`,
      )
    },
  })
  // Independent of the route set: signing in is what makes a route worth
  // adding, so the flows are offered before any profile names their provider.
  // Scoped to the authorization seam rather than injected outright, because a
  // composition without it (headless, ACP) simply has no surface to sign in
  // from, while everything else this plugin does still works.
  ctx.inject(['authorization'], (authorized) => { registerPiAiFlows(authorized, auth) })
  // The full installed catalog is configurable from the moment the plugin
  // mounts — dormant or not — so configuration surfaces can offer every
  // pi-ai provider before any route exists. Hand-declared routes join it as
  // profiles appear, and leave with them.
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  /** Provider keys the directory registration currently holds. */
  let directoryProviders: ReadonlySet<string> = new Set()
  const ensureDirectory = (): void => {
    const entries = directoryEntries(profiles(), settingsNs, managed.snapshot().routes)
    if (deepEqualJson(entries, directoryFacts)) return
    // Atomic replace, never dispose-then-register: a route another adapter
    // family already declares (a profile keyed `deepseek-official`) would
    // otherwise leave this plugin's whole directory withdrawn and the Models
    // page empty. The candidate set is validated first, so a collision keeps
    // the previous entries serving and only costs a diagnostic.
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
    directoryProviders = new Set(entries.map(entry => entry.provider))
  }
  ensureDirectory()
  /** Host-owned request inputs for discovery of one configured route. */
  const storedDiscoveryProfile = (
    provider: string | undefined,
  ): StoredModelDiscoveryProfile | undefined => {
    if (provider === undefined) return undefined
    const profile = profiles().get(provider)
    if (profile === undefined) return undefined
    return {
      headers: profile.headers,
      resolveApiKey: () => resolveApiKey(provider, profile),
    }
  }
  // Interrogating an endpoint is a configuration-time action over a draft, so
  // it is offered for the whole namespace rather than per route: the provider
  // a surface is adding does not exist yet. The draft is the whole request
  // except the stored credential and deployment-owned headers: the curated UI
  // accepts neither, so an already-configured route supplies both inside the
  // Host rather than widening the discovery request.
  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discoverModels(
    { ...request, ...signal === undefined ? {} : { signal } },
    () => storedDiscoveryProfile(request.provider),
  ))
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below. A bare
  // mount (zero routes) is the dormant posture: nothing registers until a
  // settings section supplies profiles, and routes drop when it empties.
  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  /** Route keys the adapter registration currently holds. */
  let registeredRoutes: string[] = []
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts(profiles())
    if (deepEqualJson(facts, registeredFacts)) return
    // The registry captures the route set and each route's retry policy at
    // registration, so a change to either must re-register. The swap is
    // atomic (same adapter instance, validated before anything moves): a
    // conflicting route leaves the previous routes serving requests, and
    // `registeredFacts` only advances once the registry actually holds the
    // new set — so returning to a working configuration always re-applies.
    const routes = [...profiles().keys()]
    if (registration === undefined) {
      // Dormant bare mount: nothing is registered until a section supplies
      // profiles, and an empty section keeps it that way.
      if (routes.length === 0) {
        registeredFacts = facts
        registeredRoutes = routes
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
    registeredRoutes = routes
  }
  ensureRegistrationFacts()

  /**
   * Register one prospective managed snapshot as a single transaction.
   *
   * Every route the snapshot adds must be servable by this adapter and free of
   * other adapters' registrations; every provider it adds to the directory must
   * be free of other plugins' declarations. The merged route set is registered
   * first and the directory second, so a directory refusal restores the previous
   * routes. The registry calls this with the previous snapshot when a commit
   * fails, which makes the rollback observable in the live registries.
   * @param snapshot - The managed sets a commit would publish.
   * @throws {Error} When a route or directory entry cannot be registered.
   */
  function applyProspective(
    snapshot: ManagedProvidersSnapshot,
    options: { readonly restoring: boolean },
  ): void {
    const personal = structuredClone(config.providers.get()) as import('./config.ts').Options['providers']
    // Conflict rules keep the two sets disjoint, so a managed route never shadows
    // one the user owns; the merge is only how both reach one registration.
    const next = resolveProfiles({ ...personal, ...snapshot.providers }, 'deferred')
    const routes = [...next.keys()]
    const entries = directoryEntries(next, settingsNs, snapshot.routes)
    // A rollback re-registers the last good routes, which the failed attempt may
    // have replaced; treating them as foreign would refuse the restore itself.
    if (!options.restoring) {
      const ownRoutes = new Set(registeredRoutes)
      for (const provider of ctx.llm.listProviders()) {
        if (!routes.includes(provider.id) || ownRoutes.has(provider.id)) continue
        throw new Error(
          `llm-pi-ai: model route "${provider.id}" from the managed set is already served by another adapter;`
          + ' the provider change is refused and the previous routes stay in service',
        )
      }
      const ownDirectory = new Set(directoryProviders)
      for (const entry of ctx.llm.listConfigurableProviders()) {
        if (!snapshot.routes.has(entry.provider) || ownDirectory.has(entry.provider)) continue
        throw new Error(
          `llm-pi-ai: provider "${entry.provider}" from the managed set is already declared by another plugin`
          + ` (settings namespace "${entry.settingsNs}"); the provider change is refused and the previous routes stay in service`,
        )
      }
    }
    const previousRoutes = [...registeredRoutes]
    const previousFacts = registeredFacts
    const facts = registrationFacts(next)
    // The registry captures each route's display name and retry policy at
    // registration, so a same-route change to either must re-register; comparing
    // only the route array would leave the selectors and retry behavior stale.
    const reRegister = !deepEqualJson(routes, previousRoutes) || !deepEqualJson(facts, previousFacts)
    if (reRegister) {
      if (registration === undefined) {
        if (routes.length > 0) registration = ctx.llm.registerAdapter(routes, adapter)
      } else {
        registration.replace(routes)
      }
      registeredRoutes = routes
      registeredFacts = facts
    }
    try {
      if (deepEqualJson(entries, directoryFacts)) return
      if (directory === undefined) directory = ctx.llm.registerConfigurableProviders(entries)
      else directory.replace(entries)
      directoryFacts = entries
      directoryProviders = new Set(entries.map(entry => entry.provider))
    } catch (error) {
      // No local rollback: the registry clears its candidate and calls this
      // function with the previous snapshot, which re-registers the old routes and
      // therefore captures the old facts. Restoring here would read the candidate
      // configuration and leave the adapter serving the refused display name and
      // retry policy after the failure.
      throw new Error(
        'the managed provider directory entry could not be registered: '
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }

  const refresh = (): void => {
    try { ensureRegistrationFacts(); ensureDirectory() }
    catch (error) {
      ctx.logger.error('llm-pi-ai: configuration conflicts with an existing provider route')
      ctx.logger.error(error)
    }
  }
  ctx.on('loader/volatile-update', refresh)
  // Offered last: a dependent's `contribute()` runs the registration transaction
  // above, which needs this plugin's own routes and directory already in place.
  ctx.effect(() => ctx.provide('llmPiAiManaged', managed), 'llm-pi-ai: managed provider routes')
}
