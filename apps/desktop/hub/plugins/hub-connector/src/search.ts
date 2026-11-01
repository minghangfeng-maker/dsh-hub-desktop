/**
 * The Hub search pool as this device's web provider.
 *
 * The Hub serves `POST /v1/tools/{search,fetch}` (docs/14 §3) and tells the
 * client in `GET /api/desktop/session` whether the pool is on and where it
 * lives (`tools: { search, baseUrl }`). When it is on, the connector writes two
 * overlay rows: `web` selects the DeepSeek Search/Fetch API providers, and
 * `web-deepseek-api` points them at the Hub with the credential reference the
 * relay key is already stored under — so no key ever enters configuration or
 * the process environment (same arrangement as the container preset, 14 §5).
 *
 * The fragments are `enforce`: the pool is metered by the Hub wallet, so the
 * Hub-side decision has to win over a stale profile edit. The advanced
 * "allow the official DeepSeek account" switch owns those rows instead and the
 * connector then emits nothing (see `accountSwitchRows` in `connector.ts`).
 *
 * Pure functions only: the connector calls them, tests exercise them directly.
 */

import { HUB_RELAY_REF } from './models.ts'
import type { ManifestFragment } from './manifest.ts'

/** What `GET /api/desktop/session`'s optional `tools` member says. */
export interface HubSessionTools {
  /** Whether the Hub pool is on *and* delivered to DSH. */
  readonly search: boolean
  /** DSH web-provider base URL (`<hub>/v1/tools`); null whenever `search` is false. */
  readonly baseUrl: string | null
}

/** The pool is off (also the state before the first session read). */
export const NO_HUB_SEARCH: HubSessionTools = { search: false, baseUrl: null }

/** Loader rows the search fragments configure (rows the base bundle declares). */
export const HUB_SEARCH_ROWS = {
  /** `@deepseek-ai/dsh-web`: which providers serve the model's search tools. */
  web: 'web',
  /** `@deepseek-ai/dsh-web-deepseek-api`: where those providers send requests. */
  provider: 'web-deepseek-api',
} as const

/** Provider ids `@deepseek-ai/dsh-web-deepseek-api` registers. */
export const HUB_SEARCH_PROVIDER_IDS = {
  search: 'deepseek-search-api',
  fetch: 'deepseek-fetch-api',
} as const

/** Narrow an unknown value to a plain record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Normalize the base URL the Hub reported.
 * @param value - Candidate URL (`<hub>/v1/tools`).
 * @returns The URL without a trailing slash, or null when it is unusable.
 */
export function normalizeSearchBaseUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/u, '')
  if (trimmed === '') return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  // A query or fragment would silently change the endpoint the providers append to.
  if (parsed.search !== '' || parsed.hash !== '') return null
  return trimmed
}

/**
 * Read the session's optional `tools` member defensively.
 *
 * An older Hub does not send it at all, and a mangled answer must not turn
 * search on: anything unusable degrades to {@link NO_HUB_SEARCH}.
 * @param raw - `tools` value from the session response.
 * @returns The normalized pair.
 */
export function normalizeSearchTools(raw: unknown): HubSessionTools {
  const value = record(raw)
  if (value?.search !== true) return NO_HUB_SEARCH
  const baseUrl = typeof value.baseUrl === 'string' ? normalizeSearchBaseUrl(value.baseUrl) : null
  if (baseUrl === null) return NO_HUB_SEARCH
  return { search: true, baseUrl }
}

/**
 * Render the overlay fragments that switch the Hub search pool on.
 * @param tools - Session search state.
 * @param options - `officialAccount`: the advanced switch owns these rows, emit nothing.
 * @returns Two `enforce` fragments, or none while the pool is off.
 */
export function searchFragments(
  tools: HubSessionTools,
  options: { readonly officialAccount?: boolean } = {},
): readonly ManifestFragment[] {
  if (options.officialAccount === true) return []
  if (!tools.search || tools.baseUrl === null) return []
  return [
    {
      id: HUB_SEARCH_ROWS.web,
      mode: 'enforce',
      note: 'DSH Hub search pool',
      config: {
        searchProvider: HUB_SEARCH_PROVIDER_IDS.search,
        fetchProvider: HUB_SEARCH_PROVIDER_IDS.fetch,
      },
    },
    {
      id: HUB_SEARCH_ROWS.provider,
      mode: 'enforce',
      note: 'DSH Hub search pool endpoint',
      config: {
        baseURL: tools.baseUrl,
        // The relay key lives in the credential store under this reference; it is
        // resolved per operation, so neither the overlay nor the environment holds it.
        apiKeyEnv: HUB_RELAY_REF,
      },
    },
  ]
}
