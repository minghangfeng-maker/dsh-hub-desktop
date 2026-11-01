/**
 * The installer's model snapshot (design §4.3).
 *
 * The snapshot never decides reachability: the relay's `GET /v1/models` does.
 * These cases pin the version-2 production layout, the version-1 compatibility
 * path, the per-provider intersection, the device members the connector fills in,
 * and the default selection with its fallback.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  alignRelayFragments,
  alignRelayProviders,
  BUNDLED_MODEL_SNAPSHOT,
  generateModelRoute,
  intersectSnapshotProviders,
  providerFragment,
  readBundledModelSnapshot,
} from '../../hub/plugins/hub-connector/src/models.ts'

/** The production export this build carries. */
const PRODUCTION = readFileSync(join(import.meta.dirname, '../../hub/bundled-models.json'), 'utf8')

/** A compact version-2 snapshot with two providers. */
const VERSION_2 = {
  schemaVersion: 2,
  llmPiAi: {
    providers: {
      'hub-max': {
        displayName: 'DSH Hub',
        api: 'openai-completions',
        reasoning: 'max',
        models: [{
          id: 'deepseek-v4.1-flash@relay',
          name: 'DeepSeek V4.1 Flash · relay',
          contextWindow: 1000000,
          reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
        }],
      },
      hub: {
        displayName: 'DSH Hub',
        api: 'openai-completions',
        models: [{ id: 'glm-5.3@relay', name: 'GLM-5.3 · relay' }],
      },
    },
  },
  agentDefaultModel: { provider: 'hub-max', model: 'deepseek-v4.1-flash@relay', reasoningEffort: 'max' },
}

/** Write one snapshot into a temporary installer directory. */
function installer(snapshot: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'hub-models-'))
  writeFileSync(join(directory, BUNDLED_MODEL_SNAPSHOT), JSON.stringify(snapshot))
  return directory
}

describe('bundled model snapshot', () => {
  it('reads the production export: four provider routes and its default selection', () => {
    const snapshot = readBundledModelSnapshot(installer(JSON.parse(PRODUCTION) as unknown))
    expect(snapshot?.providers.map(provider => provider.route)).toEqual(['hub-max', 'hub', 'hub-high', 'hub-xhigh'])
    expect(snapshot?.defaultSelection).toEqual({
      provider: 'hub-max', model: 'deepseek-v4.1-flash@relay', reasoningEffort: 'max',
    })
    // Model members ride through verbatim, including the thinking-level dictionary.
    const model = snapshot?.providers[0]?.models[0]
    expect(model).toMatchObject({
      id: 'example-provider/deepseek-v4.1-flash@relay',
      reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
      contextWindow: 1000000,
    })
    // No per-device member or secret travels in the snapshot (its prose may name them).
    const members = JSON.stringify(JSON.parse(PRODUCTION) as unknown, (key, value: unknown) => {
      expect(['baseURL', 'apiKeyEnv']).not.toContain(key)
      if (typeof value === 'string') expect(value.startsWith('sk-')).toBe(false)
      return value
    })
    expect(members.length).toBeGreaterThan(0)
  })

  it('keeps the provider configuration without the per-device members', () => {
    const snapshot = readBundledModelSnapshot(installer(VERSION_2))
    expect(snapshot?.providers[0]?.config).toMatchObject({
      displayName: 'DSH Hub', api: 'openai-completions', reasoning: 'max',
    })
    expect(snapshot?.providers[0]?.config).not.toHaveProperty('models')
  })

  it('still reads the version-1 flat example under one hub provider', () => {
    const snapshot = readBundledModelSnapshot(installer({
      schemaVersion: 1,
      defaultModel: 'm1',
      defaultReasoningEffort: 'high',
      models: [{ id: 'm1', displayName: 'M1', reasoningEfforts: ['low', 'high'] }],
    }))
    expect(snapshot?.providers).toEqual([{
      route: 'hub',
      config: { displayName: 'DSH Hub', api: 'openai-completions' },
      models: [{ id: 'm1', displayName: 'M1', name: 'M1', reasoningEfforts: { low: 'low', high: 'high' } }],
    }])
    expect(snapshot?.defaultSelection).toEqual({ provider: 'hub', model: 'm1', reasoningEffort: 'high' })
  })

  it('reports no snapshot when the build ships none', () => {
    expect(readBundledModelSnapshot(mkdtempSync(join(tmpdir(), 'hub-models-')))).toBeUndefined()
  })

  it('drops a thinking level pi-ai does not offer', () => {
    const snapshot = readBundledModelSnapshot(installer({
      schemaVersion: 2,
      llmPiAi: { providers: { hub: { models: [{ id: 'm1', name: 'M1', reasoningEfforts: { low: 'low', false: null, off: null } }] } } },
    }))
    expect(snapshot?.providers[0]?.models[0]?.reasoningEfforts).toEqual({ low: 'low', off: null })
  })

  it('refuses a version-2 document without providers', () => {
    expect(() => readBundledModelSnapshot(installer({ schemaVersion: 2 }))).toThrow(/llmPiAi\.providers/u)
  })
})

describe('per-provider intersection', () => {
  it('keeps the reachable models, drops an empty provider, and keeps the snapshot order', () => {
    const snapshot = readBundledModelSnapshot(installer(VERSION_2))
    if (snapshot === undefined) throw new Error('missing snapshot')
    const { providers, fromSnapshot } = intersectSnapshotProviders(snapshot, [
      { id: 'glm-5.3@relay', displayName: 'relay name' },
    ])
    expect(fromSnapshot).toBe(true)
    expect(providers.map(provider => provider.route)).toEqual(['hub'])
    expect(providers[0]?.models).toEqual([{ id: 'glm-5.3@relay', name: 'GLM-5.3 · relay' }])
  })

  it('falls back to the relay list when the snapshot names none of its models', () => {
    const snapshot = readBundledModelSnapshot(installer(VERSION_2))
    if (snapshot === undefined) throw new Error('missing snapshot')
    const relay = [{ id: 'some-other-model', displayName: 'Some Other Model' }]
    const { providers, fromSnapshot } = intersectSnapshotProviders(snapshot, relay)
    expect(fromSnapshot).toBe(false)
    expect(providers).toEqual([{
      route: 'hub',
      config: { displayName: 'DSH Hub', api: 'openai-completions' },
      models: [{ id: 'some-other-model', name: 'Some Other Model' }],
    }])
  })
})

describe('rendered provider route', () => {
  it('fills the relay origin and the credential reference on every provider', () => {
    const snapshot = readBundledModelSnapshot(installer(VERSION_2))
    if (snapshot === undefined) throw new Error('missing snapshot')
    const route = providerFragment('https://hub.example', snapshot.providers, snapshot.defaultSelection)
    const providers = route.fragment.config.providers as Record<string, Record<string, unknown>>
    expect(providers['hub-max']).toMatchObject({
      displayName: 'DSH Hub',
      api: 'openai-completions',
      reasoning: 'max',
      baseURL: 'https://hub.example/v1',
      apiKeyEnv: 'HUB_MK_HUB',
    })
    expect(providers['hub']).toMatchObject({ baseURL: 'https://hub.example/v1', apiKeyEnv: 'HUB_MK_HUB' })
    expect(route.defaultSelection).toEqual({
      provider: 'hub-max', model: 'deepseek-v4.1-flash@relay', reasoningEffort: 'max',
    })
  })

  it('uses the first available model when the named default is not reachable', () => {
    const snapshot = readBundledModelSnapshot(installer(VERSION_2))
    if (snapshot === undefined) throw new Error('missing snapshot')
    const route = providerFragment('https://hub.example', [{
      route: 'hub',
      config: { displayName: 'DSH Hub', api: 'openai-completions' },
      models: [{ id: 'glm-5.3@relay', name: 'GLM-5.3 · relay' }],
    }], snapshot.defaultSelection)
    expect(route.defaultSelection).toEqual({ provider: 'hub', model: 'glm-5.3@relay' })
  })

  it('takes the provider-level thinking level for the fallback selection', () => {
    const route = providerFragment('https://hub.example', [{
      route: 'hub-max',
      config: { displayName: 'DSH Hub', reasoning: 'high' },
      models: [{ id: 'm1', name: 'M1' }],
    }], undefined)
    expect(route.defaultSelection).toEqual({ provider: 'hub-max', model: 'm1', reasoningEffort: 'high' })
  })
})

describe('generateModelRoute', () => {
  /** One relay double answering `GET /v1/models`. */
  function fetchModels(ids: readonly string[]): typeof fetch {
    return async () => new Response(JSON.stringify({
      data: ids.map(id => ({ id, display_name: `relay ${id}` })),
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  it('renders the intersecting providers and the snapshot default', async () => {
    const original = globalThis.fetch
    globalThis.fetch = fetchModels(['deepseek-v4.1-flash@relay', 'glm-5.3@relay', 'unlisted@x'])
    try {
      const route = await generateModelRoute('https://hub.example', 'sk-dsh-test', readBundledModelSnapshot(installer(VERSION_2)))
      const providers = route?.fragment.config.providers as Record<string, { models: { id: string }[] }>
      expect(Object.keys(providers)).toEqual(['hub-max', 'hub'])
      expect(providers['hub-max']?.models.map(model => model.id)).toEqual(['deepseek-v4.1-flash@relay'])
      expect(providers['hub']?.models.map(model => model.id)).toEqual(['glm-5.3@relay'])
      expect(route?.defaultSelection).toEqual({
        provider: 'hub-max', model: 'deepseek-v4.1-flash@relay', reasoningEffort: 'max',
      })
    } finally {
      globalThis.fetch = original
    }
  })

  it('falls back to the first available model when the default is unreachable', async () => {
    const original = globalThis.fetch
    globalThis.fetch = fetchModels(['glm-5.3@relay'])
    try {
      const route = await generateModelRoute('https://hub.example', 'sk-dsh-test', readBundledModelSnapshot(installer(VERSION_2)))
      expect(route?.defaultSelection).toEqual({ provider: 'hub', model: 'glm-5.3@relay' })
    } finally {
      globalThis.fetch = original
    }
  })

  it('renders the relay list as one hub provider when no snapshot is shipped', async () => {
    const original = globalThis.fetch
    globalThis.fetch = fetchModels(['m1'])
    try {
      const route = await generateModelRoute('https://hub.example', 'sk-dsh-test')
      const providers = route?.fragment.config.providers as Record<string, { models: { id: string; name: string }[] }>
      expect(providers['hub']?.models).toEqual([{ id: 'm1', name: 'relay m1' }])
      expect(route?.defaultSelection).toEqual({ provider: 'hub', model: 'm1' })
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('delivered relay addresses', () => {
  /** The public origin a device signed in to. */
  const HUB = 'https://hub.example.com'

  /** One delivered fragment naming the relay's internal listener plus a third-party provider. */
  const delivered = {
    providers: {
      hub: {
        displayName: 'DSH Hub',
        api: 'openai-completions',
        baseURL: 'http://relay.internal:7710/v1',
        apiKeyEnv: 'HUB_MK_HUB',
        models: [{ id: 'deepseek-v4.1-flash@relay', name: 'DeepSeek V4.1 Flash' }],
      },
      'hub-anthropic': {
        displayName: 'DSH Hub',
        api: 'anthropic-messages',
        baseURL: 'http://relay.internal:7710',
        apiKeyEnv: 'HUB_MK_HUB',
        models: [{ id: 'claude-sonnet@relay', name: 'Claude Sonnet' }],
      },
      relay: {
        displayName: 'Relay',
        api: 'openai-completions',
        baseURL: 'https://relay.example.com/v1',
        apiKeyEnv: 'RELAY_KEY',
        models: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
      },
    },
  }

  it('moves an OpenAI-compatible relay provider onto this device Hub origin and keeps /v1', () => {
    const result = alignRelayProviders(delivered, HUB)
    const providers = result.config.providers as Record<string, Record<string, unknown>>
    expect(providers.hub?.baseURL).toBe(`${HUB}/v1`)
    expect(result.rewrites).toContainEqual({ provider: 'hub', from: 'http://relay.internal:7710/v1', to: `${HUB}/v1` })
    // Everything else in the provider rides through untouched.
    expect(providers.hub).toMatchObject({ apiKeyEnv: 'HUB_MK_HUB', api: 'openai-completions' })
  })

  it('keeps an Anthropic-compatible provider without /v1 on the Hub origin and no path', () => {
    const result = alignRelayProviders(delivered, HUB)
    const providers = result.config.providers as Record<string, Record<string, unknown>>
    expect(providers['hub-anthropic']?.baseURL).toBe(HUB)
    expect(result.rewrites.map(entry => entry.provider)).toEqual(['hub', 'hub-anthropic'])
  })

  it('leaves a provider that does not use the Hub relay credential alone', () => {
    const result = alignRelayProviders(delivered, HUB)
    const providers = result.config.providers as Record<string, Record<string, unknown>>
    expect(providers.relay?.baseURL).toBe('https://relay.example.com/v1')
    expect(result.rewrites.map(entry => entry.provider)).not.toContain('relay')
  })

  it('changes nothing when the delivered address already is this device Hub', () => {
    const same = { providers: { hub: { baseURL: `${HUB}/v1`, apiKeyEnv: 'HUB_MK_HUB' } } }
    const result = alignRelayProviders(same, HUB)
    expect(result.rewrites).toEqual([])
    expect(result.config).toBe(same)
  })

  it('keeps an unparsable base URL instead of guessing a path', () => {
    const broken = { providers: { hub: { baseURL: 'not a url', apiKeyEnv: 'HUB_MK_HUB' } } }
    const result = alignRelayProviders(broken, HUB)
    expect(result.rewrites).toEqual([])
    expect((result.config.providers as Record<string, Record<string, unknown>>).hub?.baseURL).toBe('not a url')
  })

  it('aligns the llm-pi-ai fragment and leaves every other fragment byte-identical', () => {
    const fragments = [
      { id: 'llm-pi-ai', mode: 'enforce' as const, config: delivered },
      { id: 'agent-default-model', mode: 'enforce' as const, config: { provider: 'hub', model: 'x' } },
    ]
    const result = alignRelayFragments(fragments, HUB)
    expect(result.rewrites).toHaveLength(2)
    expect((result.fragments[0]?.config.providers as Record<string, Record<string, unknown>>).hub?.baseURL).toBe(`${HUB}/v1`)
    expect(result.fragments[1]).toBe(fragments[1])
  })
})
