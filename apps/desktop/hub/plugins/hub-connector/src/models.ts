/**
 * The Hub relay as this device's model provider.
 *
 * Until a manifest delivers its own `llm-pi-ai` fragment, logging in is enough
 * to have working models: the device asks the relay `GET /v1/models` with its
 * own `sk-dsh-…` key and renders provider routes from the answer. A route names
 * the credential reference `HUB_MK_HUB` rather than a key, so the key never
 * enters configuration or a log — exactly the container preset's arrangement,
 * which is why a Hub-rendered fragment can replace this one verbatim.
 *
 * The installer also carries `bundled-models.json`, a snapshot of the desktop
 * default preset (design §4.3): the Hub's own `llm-pi-ai` fragment minus the
 * per-device members (`baseURL`, `apiKeyEnv`) plus `agentDefaultModel`. The
 * snapshot never decides what a user can reach — `GET /v1/models` does — so each
 * provider keeps only the models the device actually has, a provider left empty
 * disappears, and the snapshot only supplies the display copy, the model
 * parameters, the provider-level thinking level, and the default selection. A
 * manifest that delivers its own model fragment outranks both: the overlay keeps
 * the first fragment per row id, and the delivered one comes first.
 *
 * Both snapshot layouts are read: version 2 is the production export, version 1
 * is the flat example the first build of this feature carried.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HubRequestError, hubRequest } from './hub-client.ts'
import { info, warn } from './log.ts'
import type { ManifestFragment } from './manifest.ts'
import { HUB_STATE_DIRECTORY } from './state.ts'

/**
 * The installer's model snapshot file, written beside the bundled plugin
 * archives by the packaging step.
 */
export const BUNDLED_MODEL_SNAPSHOT = 'bundled-models.json'

/** Provider route key the flat example installs under; version 2 names its own routes. */
export const HUB_PROVIDER_ROUTE = 'hub'

/** Credential reference the relay key is resolved through (the Hub's own env name). */
export const HUB_RELAY_REF = 'HUB_MK_HUB'

/** Thinking levels pi-ai accepts, in escalation order (see `@deepseek-ai/dsh-llm-pi-ai`). */
const THINKING_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** One model the relay advertises. */
export interface HubModelEntry {
  /** Model id as the relay expects it in a request. */
  readonly id: string
  /** Display name for the picker. */
  readonly displayName: string
}

/** One provider route the snapshot declares. */
export interface SnapshotProvider {
  /** Route key the provider is configured under (`hub`, `hub-max`, …). */
  readonly route: string
  /** Provider configuration without the models, the base URL, or the credential reference. */
  readonly config: Record<string, unknown>
  /** Models the preset offers under this provider. */
  readonly models: readonly Record<string, unknown>[]
}

/** The installer's snapshot of the desktop default preset. */
export interface BundledModelSnapshot {
  /** Provider routes, in the snapshot's order. */
  readonly providers: readonly SnapshotProvider[]
  /** Default the preset names, when it names one. */
  readonly defaultSelection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined
}

/** What the generated route implies for the default selection. */
export interface GeneratedModelRoute {
  /** The `llm-pi-ai` fragment to write into the overlay. */
  readonly fragment: ManifestFragment
  /** Provider route and model the default selection should name. */
  readonly defaultSelection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
}

/** Narrow an unknown value to a plain record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a non-empty string member. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Copy a provider configuration without the members the device fills in. */
function providerConfig(value: Record<string, unknown>): Record<string, unknown> {
  const config = { ...value }
  delete config.models
  delete config.baseURL
  delete config.apiKeyEnv
  return config
}

/** Keep only the thinking levels pi-ai offers; the Hub's own renderer drops the rest. */
function knownReasoningEfforts(value: unknown): Record<string, string | null> | undefined {
  const efforts = record(value)
  if (efforts === undefined) return undefined
  const kept: Record<string, string | null> = {}
  for (const [level, wire] of Object.entries(efforts)) {
    if (!THINKING_LEVELS.includes(level) || (wire !== null && typeof wire !== 'string')) continue
    kept[level] = wire
  }
  return Object.keys(kept).length === 0 ? undefined : kept
}

/** Read the models of one snapshot provider, keeping unknown model members for the rendered route. */
function snapshotModels(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): Record<string, unknown>[] => {
    const model = record(entry)
    const id = text(model?.id)
    const name = text(model?.name)
    if (id === undefined || name === undefined || model === undefined) return []
    const efforts = knownReasoningEfforts(model.reasoningEfforts)
    const { reasoningEfforts: _dropped, ...rest } = { ...model, id, name } as Record<string, unknown> & { reasoningEfforts?: unknown }
    return [{ ...rest, ...efforts === undefined ? {} : { reasoningEfforts: efforts } }]
  })
}

/**
 * Read the version-2 snapshot: the Hub's fragment minus the per-device members.
 * @param root - Parsed snapshot document.
 * @returns Providers and the named default, or undefined when the document is not version 2.
 */
function readVersion2(root: Record<string, unknown>): BundledModelSnapshot | undefined {
  if (root.schemaVersion !== 2) return undefined
  const providers = record(record(root.llmPiAi)?.providers)
  if (providers === undefined) throw new Error('hub models: schemaVersion 2 needs llmPiAi.providers')
  const list = Object.entries(providers).flatMap(([route, value]): SnapshotProvider[] => {
    const provider = record(value)
    if (provider === undefined) throw new Error(`hub models: provider ${route} is not an object`)
    const models = snapshotModels(provider.models)
    return models.length === 0 ? [] : [{ route, config: providerConfig(provider), models }]
  })
  const selection = record(root.agentDefaultModel)
  const provider = text(selection?.provider)
  const model = text(selection?.model)
  const effort = text(selection?.reasoningEffort)
  return {
    providers: list,
    defaultSelection: provider === undefined || model === undefined
      ? undefined
      : { provider, model, ...effort === undefined ? {} : { reasoningEffort: effort } },
  }
}

/**
 * Read the version-1 snapshot: a flat model list with one default.
 * @param root - Parsed snapshot document.
 * @returns One `hub` provider plus the named default, or undefined when the document is not version 1.
 */
function readVersion1(root: Record<string, unknown>): BundledModelSnapshot | undefined {
  if (root.schemaVersion !== 1) return undefined
  if (!Array.isArray(root.models) || root.models.length === 0) throw new Error('hub models: schemaVersion 1 lists no model')
  const models = snapshotModels(root.models.flatMap((entry): Record<string, unknown>[] => {
    const model = record(entry)
    const displayName = text(model?.displayName)
    if (displayName === undefined) return []
    // Version 1 listed levels; the rendered route uses pi-ai's level dictionary.
    const levels = Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts : undefined
    const efforts = levels === undefined
      ? undefined
      : Object.fromEntries(levels.filter((level): level is string => typeof level === 'string')
        .map(level => [level, level === 'off' ? null : level]))
    return [{ ...model, ...efforts === undefined ? {} : { reasoningEfforts: efforts }, name: displayName }]
  }))
  const firstId = models[0]?.id
  const defaultModel = text(root.defaultModel) ?? (typeof firstId === 'string' ? firstId : undefined)
  if (defaultModel === undefined) throw new Error('hub models: no default model')
  const effort = text(root.defaultReasoningEffort)
  return {
    providers: [{ route: HUB_PROVIDER_ROUTE, config: { displayName: 'DSH Hub', api: 'openai-completions' }, models }],
    defaultSelection: {
      provider: HUB_PROVIDER_ROUTE,
      model: defaultModel,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    },
  }
}

/** Loader row id the Hub's model routes are delivered under. */
export const MODEL_FRAGMENT_ID = 'llm-pi-ai'

/** Loader row id the Hub's recommended default model is delivered under. */
export const DEFAULT_MODEL_FRAGMENT_ID = 'agent-default-model'

/**
 * The model configuration one delivery owns, kept outside the user's settings.
 *
 * The desktop registers these routes through the adapter's managed-provider
 * surface instead of the Hub overlay: the overlay is the last patch layer, so a
 * row there would win over the profile patch the Models page writes and every
 * personal edit would be refused as overridden.
 */
export interface HubModelOwnership {
  /** Provider profiles keyed by route, exactly as the Hub delivered them. */
  readonly providers: Record<string, unknown>
  /** The default model the Hub recommends, when the delivery names one. */
  readonly defaultSelection?: HubDefaultSelection
}

/** One default model a delivery recommends. */
export interface HubDefaultSelection {
  /** Provider route the model belongs to. */
  readonly provider: string
  /** Model id as the route expects it. */
  readonly model: string
  /** Adapter reasoning level the Hub chose, when it chose one. */
  readonly reasoningEffort?: string
}

/**
 * Read the default selection out of an `agent-default-model` fragment body.
 * @param value - Fragment config as delivered.
 * @returns The selection, or undefined when it does not name a provider and a model.
 */
export function readDefaultSelection(value: unknown): HubDefaultSelection | undefined {
  const config = record(value)
  const provider = text(config?.provider)
  const model = text(config?.model)
  if (provider === undefined || model === undefined) return undefined
  const effort = text(config?.reasoningEffort)
  return {
    provider,
    model,
    ...effort === undefined || !THINKING_LEVELS.includes(effort) ? {} : { reasoningEffort: effort },
  }
}

/**
 * Collect the model rows one delivery owns.
 *
 * Both rows leave the overlay: the routes become a managed provider set the
 * adapter registers, and the default is a recommendation that only applies
 * while the user has chosen nothing.
 * @param fragments - Delivered fragments, in delivery order.
 * @returns The owned model set, or undefined when the delivery names none.
 */
export function hubModelOwnership(fragments: readonly ManifestFragment[]): HubModelOwnership | undefined {
  const model = fragments.find(fragment => fragment.id === MODEL_FRAGMENT_ID)
  const selection = fragments.find(fragment => fragment.id === DEFAULT_MODEL_FRAGMENT_ID)
  const providers = record(model?.config.providers)
  const defaultSelection = readDefaultSelection(selection?.config)
  if (providers === undefined && defaultSelection === undefined) return undefined
  return { providers: providers ?? {}, ...defaultSelection === undefined ? {} : { defaultSelection } }
}

/**
 * Whether one Loader row id belongs to the Hub's model ownership.
 * @param id - Fragment or patch row id.
 * @returns True for the two rows the adapter registration carries instead of the overlay.
 */
export function isModelRow(id: string): boolean {
  return id === MODEL_FRAGMENT_ID || id === DEFAULT_MODEL_FRAGMENT_ID
}

/**
 * Read the provider dict out of a generated `llm-pi-ai` fragment.
 * @param config - Fragment config.
 * @returns The providers, or undefined when the fragment carries none.
 */
export function routeProviders(config: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(config.providers)
}

/**
 * Whether one provider profile lists a model id.
 *
 * A profile without a `models` list serves its installed catalog, which this
 * connector cannot enumerate; only a declared list can contradict a selection.
 * @param value - Provider profile as delivered.
 * @param model - Model id the default selection names.
 * @returns True when the profile does not contradict the selection.
 */
export function providerServesModel(value: unknown, model: string): boolean {
  const provider = record(value)
  if (provider === undefined) return false
  const models = provider.models
  if (!Array.isArray(models)) return true
  return models.some((entry) => {
    const candidate = record(entry)
    return typeof candidate?.id === 'string' && candidate.id === model
  })
}

/**
 * Drop the model rows from a fragment list.
 * @param fragments - Fragments a delivery or the connector produced.
 * @returns The fragments the overlay may carry.
 */
export function withoutModelRows(fragments: readonly ManifestFragment[]): ManifestFragment[] {
  return fragments.filter(fragment => !isModelRow(fragment.id))
}

/** Migration file the desktop Host leaves when it strips the model rows from an old overlay. */
export const LEGACY_MODEL_FILE = 'legacy-models.json'

/**
 * Read the model rows an upgraded desktop Host extracted from an old overlay.
 * @param profile - Desktop profile directory.
 * @returns The extracted ownership, or undefined when the file is absent.
 * @throws {Error} When the file exists but does not hold a provider record; the caller keeps it for inspection.
 */
export function readLegacyModelOwnership(profile: string): HubModelOwnership | undefined {
  const path = join(profile, HUB_STATE_DIRECTORY, LEGACY_MODEL_FILE)
  if (!existsSync(path)) return undefined
  const parsed = record(JSON.parse(readFileSync(path, 'utf8')))
  const providers = record(parsed?.providers)
  if (parsed === undefined || providers === undefined) {
    throw new Error(`hub models: ${path} does not hold a provider record`)
  }
  const defaultSelection = readDefaultSelection(parsed.defaultSelection)
  return { providers, ...defaultSelection === undefined ? {} : { defaultSelection } }
}

/**
 * Absolute path of the migration file, for the caller that consumes and removes it.
 * @param profile - Desktop profile directory.
 * @returns Path below `desktop-hub/`.
 */
export function legacyModelPath(profile: string): string {
  return join(profile, HUB_STATE_DIRECTORY, LEGACY_MODEL_FILE)
}

/** One provider whose base URL a delivered fragment pointed at another origin. */
export interface RelayOriginRewrite {
  /** Provider route key inside the fragment. */
  readonly provider: string
  /** Base URL the Hub delivered. */
  readonly from: string
  /** Base URL this device will call. */
  readonly to: string
}

/** What aligning one delivered `llm-pi-ai` config achieved. */
export interface RelayOriginAlignment {
  /** The config, with any rewrite applied. */
  readonly config: Record<string, unknown>
  /** Providers whose base URL was moved to this device's Hub. */
  readonly rewrites: readonly RelayOriginRewrite[]
}

/**
 * Point Hub relay providers at this device's Hub origin.
 *
 * A Hub that renders the desktop fragment for a container can deliver the relay's
 * internal listener (`http://relay.internal:7710/v1`) instead of its public origin; the
 * desktop cannot route there, and the failure surfaces as an unreachable model
 * rather than as a bad manifest. Only providers that reference the Hub relay
 * credential are touched, so a provider the operator pointed at a third-party
 * endpoint keeps its own address; the path is preserved, because the relay serves
 * OpenAI-compatible providers under `/v1` and Anthropic-compatible ones without it.
 * @param config - Delivered `llm-pi-ai` config (`{ providers: { … } }`).
 * @param hubOrigin - This device's Hub origin.
 * @returns The config to render, plus what was rewritten for the log.
 */
export function alignRelayProviders(config: Record<string, unknown>, hubOrigin: string): RelayOriginAlignment {
  const providers = record(config.providers)
  if (providers === undefined || hubOrigin === '') return { config, rewrites: [] }
  let hub: URL
  try {
    hub = new URL(hubOrigin)
  } catch {
    return { config, rewrites: [] }
  }
  const rewrites: RelayOriginRewrite[] = []
  const aligned: Record<string, unknown> = {}
  for (const [route, value] of Object.entries(providers)) {
    const provider = record(value)
    if (provider === undefined || provider.apiKeyEnv !== HUB_RELAY_REF) {
      aligned[route] = value
      continue
    }
    const baseURL = text(provider.baseURL)
    if (baseURL === undefined) {
      aligned[route] = value
      continue
    }
    let delivered: URL
    try {
      delivered = new URL(baseURL)
    } catch {
      // An unparsable address is the Hub's to fix; rewriting it would guess at a path.
      aligned[route] = value
      continue
    }
    if (delivered.origin === hub.origin) {
      aligned[route] = value
      continue
    }
    const path = delivered.pathname === '/' ? '' : delivered.pathname
    const to = `${hub.origin}${path}`
    aligned[route] = { ...provider, baseURL: to }
    rewrites.push({ provider: route, from: baseURL, to })
  }
  if (rewrites.length === 0) return { config, rewrites }
  return { config: { ...config, providers: aligned }, rewrites }
}

/**
 * Align every delivered `llm-pi-ai` fragment with this device's Hub origin.
 * @param fragments - Fragments the manifest delivered, in delivery order.
 * @param hubOrigin - This device's Hub origin.
 * @returns The fragments to render, with relay addresses this device can reach.
 */
export function alignRelayFragments(
  fragments: readonly ManifestFragment[],
  hubOrigin: string,
): { fragments: readonly ManifestFragment[]; rewrites: readonly RelayOriginRewrite[] } {
  const rewrites: RelayOriginRewrite[] = []
  const aligned = fragments.map((fragment) => {
    if (fragment.id !== 'llm-pi-ai') return fragment
    const result = alignRelayProviders(fragment.config, hubOrigin)
    rewrites.push(...result.rewrites)
    return result.rewrites.length === 0 ? fragment : { ...fragment, config: result.config }
  })
  return { fragments: aligned, rewrites }
}

/**
 * Read the installer's model snapshot.
 * @param directory - `resources/runtime/hub-plugins` of the running application.
 * @returns The normalized snapshot, or undefined when this build carries none.
 * @throws {Error} When the file exists but does not describe a usable snapshot.
 */
export function readBundledModelSnapshot(directory: string): BundledModelSnapshot | undefined {
  const path = join(directory, BUNDLED_MODEL_SNAPSHOT)
  if (!existsSync(path)) return undefined
  const root = record(JSON.parse(readFileSync(path, 'utf8')))
  if (root === undefined) throw new Error(`hub models: ${path} must hold an object`)
  const snapshot = readVersion2(root) ?? readVersion1(root)
  if (snapshot === undefined) throw new Error(`hub models: ${path} must declare schemaVersion 1 or 2`)
  if (snapshot.providers.length === 0) throw new Error(`hub models: ${path} has no model under any provider`)
  return snapshot
}

/**
 * Read the relay's model list.
 * @param hubOrigin - Hub origin.
 * @param key - The device's relay key (`sk-dsh-…`).
 * @param signal - Caller cancellation.
 * @returns Advertised models, order preserved, duplicates dropped.
 * @throws {HubRequestError} When the relay refuses or is unreachable.
 */
export async function listRelayModels(hubOrigin: string, key: string, signal?: AbortSignal): Promise<HubModelEntry[]> {
  const response = await hubRequest<{ data?: unknown }>({
    url: `${hubOrigin}/v1/models`,
    token: key,
    ...signal === undefined ? {} : { signal },
  })
  const data = record(response.body)?.data
  if (!Array.isArray(data)) throw new HubRequestError('invalid-body', 'the relay returned no model list', response.status)
  const seen = new Set<string>()
  const models: HubModelEntry[] = []
  for (const entry of data) {
    const value = record(entry)
    const id = typeof value?.id === 'string' ? value.id : undefined
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const displayName = typeof value?.display_name === 'string' && value.display_name !== '' ? value.display_name : id
    models.push({ id, displayName })
  }
  return models
}

/**
 * Keep only the models the relay advertises, and drop a provider left empty.
 *
 * The relay decides reachability, so a model the user cannot call never renders.
 * When no provider keeps a model (a snapshot that predates this relay), the
 * relay's own list is rendered as one `hub` provider rather than leaving the
 * picker empty.
 * @param snapshot - Installer snapshot.
 * @param advertised - Models the relay advertises.
 * @returns Providers to render, and whether the snapshot's own routes survived.
 */
export function intersectSnapshotProviders(
  snapshot: BundledModelSnapshot,
  advertised: readonly HubModelEntry[],
): { providers: SnapshotProvider[]; fromSnapshot: boolean } {
  const available = new Set(advertised.map(model => model.id))
  const providers = snapshot.providers.flatMap((provider): SnapshotProvider[] => {
    const models = provider.models.filter(model => available.has(String(model.id)))
    return models.length === 0 ? [] : [{ ...provider, models }]
  })
  if (providers.length > 0) return { providers, fromSnapshot: true }
  warn('the installer model snapshot names none of the models this relay serves; rendering the relay list')
  return {
    providers: [{
      route: HUB_PROVIDER_ROUTE,
      config: { displayName: 'DSH Hub', api: 'openai-completions' },
      models: advertised.map(model => ({ id: model.id, name: model.displayName })),
    }],
    fromSnapshot: false,
  }
}

/** Pick the first rendered model, with its provider's thinking level when it declares one. */
function fallbackSelection(
  providers: readonly SnapshotProvider[],
): { provider: string; model: string; reasoningEffort?: string } {
  const provider = providers[0]
  const model = provider?.models[0]
  if (provider === undefined || model === undefined) return { provider: HUB_PROVIDER_ROUTE, model: '' }
  const effort = provider.config.reasoning
  return {
    provider: provider.route,
    model: String(model.id),
    ...typeof effort === 'string' && THINKING_LEVELS.includes(effort) ? { reasoningEffort: effort } : {},
  }
}

/**
 * Render the provider fragment and the default selection it implies.
 * @param hubOrigin - Hub origin; every route's base URL is `<origin>/v1`.
 * @param providers - Providers to render.
 * @param defaultSelection - Selection the snapshot names, or undefined.
 * @returns The `llm-pi-ai` fragment and the selection to save.
 */
export function providerFragment(
  hubOrigin: string,
  providers: readonly SnapshotProvider[],
  defaultSelection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined,
): GeneratedModelRoute {
  const routes: Record<string, unknown> = {}
  for (const provider of providers) {
    routes[provider.route] = {
      ...provider.config,
      // The relay speaks the OpenAI chat protocol on `<hub>/v1`; the key stays a reference.
      baseURL: `${hubOrigin}/v1`,
      apiKeyEnv: HUB_RELAY_REF,
      models: provider.models,
    }
  }
  const chosen = defaultSelection !== undefined
    && providers.some(provider => provider.route === defaultSelection.provider
      && provider.models.some(model => model.id === defaultSelection.model))
    ? defaultSelection
    : fallbackSelection(providers)
  return {
    fragment: {
      id: 'llm-pi-ai',
      mode: 'default',
      note: 'DSH Hub relay generated from GET /v1/models',
      config: { providers: routes },
    },
    defaultSelection: chosen,
  }
}

/**
 * Build the route the relay's own list implies, with the snapshot's providers and default.
 * @param hubOrigin - Hub origin.
 * @param key - The device's relay key.
 * @param snapshot - Installer snapshot, when the build carries one.
 * @param signal - Caller cancellation.
 * @returns The fragment and default selection, or undefined when the relay published no model.
 */
export async function generateModelRoute(
  hubOrigin: string,
  key: string,
  snapshot?: BundledModelSnapshot,
  signal?: AbortSignal,
): Promise<GeneratedModelRoute | undefined> {
  try {
    const advertised = await listRelayModels(hubOrigin, key, signal)
    if (advertised.length === 0) {
      warn('the Hub relay advertises no model for this device; the model picker stays empty')
      return undefined
    }
    if (snapshot === undefined) {
      info(`rendered the Hub model route with ${String(advertised.length)} model(s)`)
      return providerFragment(hubOrigin, [{
        route: HUB_PROVIDER_ROUTE,
        config: { displayName: 'DSH Hub', api: 'openai-completions' },
        models: advertised.map(model => ({ id: model.id, name: model.displayName })),
      }], undefined)
    }
    const { providers, fromSnapshot } = intersectSnapshotProviders(snapshot, advertised)
    const total = providers.reduce((count, provider) => count + provider.models.length, 0)
    info(`rendered the Hub model route with ${String(total)} model(s)${fromSnapshot ? '' : ' (relay list fallback)'}`)
    return providerFragment(hubOrigin, providers, snapshot.defaultSelection)
  } catch (error) {
    warn(`could not read the Hub model list (${error instanceof HubRequestError ? error.code : 'network'})`)
    return undefined
  }
}
