/**
 * The Hub search pool as this device's web provider.
 *
 * The Hub answers `tools: { search, baseUrl }` in `GET /api/desktop/session`; the
 * connector turns that into two overlay rows. These tests cover the pure part:
 * a defensive read of the Hub's answer, the URL normalization the DSH providers
 * rely on (they append `/search` and `/fetch` themselves), and the exact rows the
 * overlay then carries — no key anywhere except the credential reference.
 */

import { describe, expect, it } from 'vitest'
import {
  HUB_SEARCH_PROVIDER_IDS,
  HUB_SEARCH_ROWS,
  NO_HUB_SEARCH,
  normalizeSearchBaseUrl,
  normalizeSearchTools,
  searchFragments,
} from '../../hub/plugins/hub-connector/src/search.ts'
import { HUB_RELAY_REF } from '../../hub/plugins/hub-connector/src/models.ts'
import { renderOverlay } from '../../hub/plugins/hub-connector/src/overlay.ts'

describe('search base URL normalization', () => {
  it('keeps the pool endpoint as the DSH providers need it', () => {
    expect(normalizeSearchBaseUrl('http://127.0.0.1:7976/v1/tools')).toBe('http://127.0.0.1:7976/v1/tools')
    expect(normalizeSearchBaseUrl('https://hub.example.com/v1/tools/')).toBe('https://hub.example.com/v1/tools')
    expect(normalizeSearchBaseUrl('  https://hub.example.com/v1/tools///  ')).toBe('https://hub.example.com/v1/tools')
  })

  it('refuses anything the providers could not append to', () => {
    expect(normalizeSearchBaseUrl('')).toBeNull()
    expect(normalizeSearchBaseUrl('   ')).toBeNull()
    expect(normalizeSearchBaseUrl('not a url')).toBeNull()
    expect(normalizeSearchBaseUrl('/v1/tools')).toBeNull()
    expect(normalizeSearchBaseUrl('ftp://hub.test/v1/tools')).toBeNull()
    // A query or fragment would silently change the endpoint `/search` lands on.
    expect(normalizeSearchBaseUrl('https://hub.test/v1/tools?token=x')).toBeNull()
    expect(normalizeSearchBaseUrl('https://hub.test/v1/tools#x')).toBeNull()
  })
})

describe('reading the session tools member', () => {
  it('is off when the Hub says nothing (older Hub) or says off', () => {
    expect(normalizeSearchTools(undefined)).toEqual(NO_HUB_SEARCH)
    expect(normalizeSearchTools(null)).toEqual(NO_HUB_SEARCH)
    expect(normalizeSearchTools('search')).toEqual(NO_HUB_SEARCH)
    expect(normalizeSearchTools({})).toEqual(NO_HUB_SEARCH)
    expect(normalizeSearchTools({ search: false, baseUrl: 'https://hub.test/v1/tools' })).toEqual(NO_HUB_SEARCH)
    expect(normalizeSearchTools({ search: 'true', baseUrl: 'https://hub.test/v1/tools' })).toEqual(NO_HUB_SEARCH)
  })

  it('is on only with a usable base URL', () => {
    expect(normalizeSearchTools({ search: true, baseUrl: 'https://hub.test/v1/tools/' })).toEqual({
      search: true,
      baseUrl: 'https://hub.test/v1/tools',
    })
    expect(normalizeSearchTools({ search: true, baseUrl: null })).toEqual(NO_HUB_SEARCH)
    expect(normalizeSearchTools({ search: true })).toEqual(NO_HUB_SEARCH)
    expect(normalizeSearchTools({ search: true, baseUrl: 'file:///etc/passwd' })).toEqual(NO_HUB_SEARCH)
  })
})

describe('search fragments', () => {
  const on = { search: true, baseUrl: 'https://hub.example.com/v1/tools' } as const

  it('renders both rows, enforced, when the pool is served', () => {
    const fragments = searchFragments(on)
    expect(fragments.map(fragment => fragment.id)).toEqual([HUB_SEARCH_ROWS.web, HUB_SEARCH_ROWS.provider])
    expect(fragments.every(fragment => fragment.mode === 'enforce')).toBe(true)
    expect(fragments[0]?.config).toEqual({
      searchProvider: HUB_SEARCH_PROVIDER_IDS.search,
      fetchProvider: HUB_SEARCH_PROVIDER_IDS.fetch,
    })
    expect(fragments[1]?.config).toEqual({ baseURL: on.baseUrl, apiKeyEnv: HUB_RELAY_REF })
  })

  it('never carries a key, only the credential reference', () => {
    const text = JSON.stringify(searchFragments({ search: true, baseUrl: 'https://hub.test/v1/tools' }))
    expect(text).toContain('"apiKeyEnv":"HUB_MK_HUB"')
    expect(text).not.toContain('apiKey"')
    expect(text).not.toContain('sk-dsh-')
    expect(text).not.toContain('DEEPSEEK_API_KEY')
  })

  it('renders nothing while the pool is off', () => {
    expect(searchFragments(NO_HUB_SEARCH)).toEqual([])
    expect(searchFragments({ search: false, baseUrl: 'https://hub.test/v1/tools' })).toEqual([])
    expect(searchFragments({ search: true, baseUrl: null })).toEqual([])
  })

  it('stands down in official-account mode, where the switch owns those rows', () => {
    expect(searchFragments(on, { officialAccount: true })).toEqual([])
  })

  it('generating the rows leaves the process environment untouched', () => {
    const before = Object.keys(process.env).sort()
    searchFragments(on)
    expect(Object.keys(process.env).sort()).toEqual(before)
    expect(process.env[HUB_RELAY_REF]).toBeUndefined()
  })
})

describe('overlay rows the search fragments produce', () => {
  it('writes both rows with the Hub endpoint and no secret', () => {
    const rendered = renderOverlay({
      revision: 4,
      connectorRow: true,
      fragments: searchFragments({ search: true, baseUrl: 'https://hub.example.com/v1/tools' }),
    }, { userDeclared: new Set() })
    expect(rendered.text).toContain('- id: web\n  config: {"searchProvider":"deepseek-search-api","fetchProvider":"deepseek-fetch-api"}')
    expect(rendered.text).toContain(
      '- id: web-deepseek-api\n  config: {"baseURL":"https://hub.example.com/v1/tools","apiKeyEnv":"HUB_MK_HUB"}',
    )
    expect(rendered.text).not.toContain('sk-dsh-')
    expect(rendered.text).not.toContain('DEEPSEEK_API_KEY')
  })

  it('writes nothing when the pool is off, so the bundle defaults stay as they are', () => {
    const rendered = renderOverlay({
      revision: null,
      connectorRow: true,
      fragments: searchFragments(NO_HUB_SEARCH),
    }, { userDeclared: new Set() })
    expect(rendered.text).not.toContain('- id: web')
    expect(rendered.text).not.toContain('web-deepseek-api')
  })
})
