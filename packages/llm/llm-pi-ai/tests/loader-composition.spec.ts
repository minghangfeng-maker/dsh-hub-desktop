/** Profile patch edits and credential updates reach the next real adapter request. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createMessage, createUserMessage, userAgent } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

/** One text block, then a tool call truncated by the output-token ceiling. */
const truncatedToolCallEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"partial"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"echo","arguments":"{\\"text\\":"}}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}',
  '[DONE]',
]

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

/** Boot the dormant composition: a bare `llm-pi-ai` row with no config at all. */
async function loadComposition(
  extraRefs: Readonly<Record<string, string>> = {},
): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-composition-'))
  const refs = ['  PI_COMPOSITION_KEY: key-from-store', ...Object.entries(extraRefs).map(([ref, value]) => `  ${ref}: ${value}`)].join('\n')
  await writeFile(join(root, '.credentials.yaml'), `version: 1\nrefs:\n${refs}\n`, { mode: 0o600 })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    '- id: authorization',
    "  name: '@deepseek-ai/dsh-authorization'",
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-authorization', AuthorizationService],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  const patchPath = await profileComposition(ctx, root, configPath)
  return { ctx, settingsPath: patchPath }
}

describe('llm-pi-ai real dormant composition', () => {
  it('boots with zero routes and registers one the moment settings supply a profile', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()

    // The shipped posture: the adapter exists, no route does.
    expect(ctx.llm.listProviders()).toEqual([])
    const directory = ctx.llm.listConfigurableProviders()
    expect(directory.find(entry => entry.provider === 'azure')).toMatchObject({
      nativeAuth: { env: ['AZURE_OPENAI_API_KEY'], oauth: false },
      baseURLEnv: ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME'],
    })
    expect(directory.find(entry => entry.provider === 'radius')?.defaultBaseURL).toBe('https://radius.pi.dev/v1')
    expect(directory.find(entry => entry.provider === 'opencode')?.defaultBaseURL).toBeUndefined()

    // Exactly what the web Models page leaves on disk.
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
  })

  it('offers OpenAI sign-in by API key only, while other subscription logins stay', async () => {
    const { ctx } = await loadComposition()
    const methods = (provider: string): string[] | undefined => ctx.authorization.list()
      .find(entry => entry.key === LlmPiAi.recordKeyFor(provider))?.methods.map(method => method.id)

    // pi-ai's Sign in with ChatGPT needs an installation ID the harness does
    // not supply, so the route offers only its key login.
    expect(methods('openai')).toEqual(['api-key'])
    expect(methods('anthropic')).toEqual(['oauth', 'api-key'])
  })

  it('uses settings-only route headers for model discovery', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ body: JSON.stringify({ data: [{ id: 'acme-private' }] }) }])
    const { ctx, settingsPath } = await loadComposition()

    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      acme-gateway:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      '        api: openai-completions',
      `        baseURL: ${server.url}`,
      '        headers:',
      '          X-Company-Code: private-tenant',
      '          Accept: text/plain',
      '          User-Agent: deployment-owned',
      '        models:',
      '          - id: acme-bootstrap',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['acme-gateway'])
    }, { timeout: 5000 })

    await expect(ctx.llm.discoverModels('llm-pi-ai', {
      provider: 'acme-gateway',
      baseURL: server.url,
      api: 'openai-completions',
    })).resolves.toEqual([{ id: 'acme-private', name: 'acme-private' }])
    expect(server.paths).toEqual(['/models'])
    expect(server.headers[0]?.['x-company-code']).toBe('private-tenant')
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
    expect(server.headers[0]?.accept).toBe('application/json')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it('continues natively after max-token assembly drops a tool call, with pruned replay metadata', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([
      { events: truncatedToolCallEvents },
      { events: textEvents },
    ])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const truncated = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      messages: [],
    })
    expect(truncated.finish).toEqual({ kind: 'max-tokens' })
    expect(truncated.message.content).toEqual([{ type: 'text', text: 'partial' }])
    expect(truncated.message.source).toEqual({
      kind: 'model',
      provider: 'deepseek',
      model: 'deepseek-flash',
      replayState: {
        response: {
          kind: 'pi-ai',
          version: 2,
          api: 'openai-completions',
          provider: 'deepseek',
          model: 'deepseek-flash',
          stopReason: 'length',
        },
        blocks: [{ type: 'text' }],
      },
    })

    const continued = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      messages: [
        truncated.message,
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
      ],
    })
    expect(continued.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]).toMatchObject({
      messages: [
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue' },
      ],
    })
    const followup = server.requests[1] as { messages?: unknown[] }
    expect(followup.messages?.[0]).not.toHaveProperty('tool_calls')
  })

  it('continues a legacy session whose stored replay state no longer matches its content', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    // A pre-envelope session log entry: max-token assembly dropped the tool
    // call from content while the flat v1 state still describes both blocks.
    const poisoned = createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      source: {
        kind: 'model',
        ...{
          provider: 'deepseek',
          model: 'deepseek-flash',
          replayState: {
            kind: 'pi-ai',
            version: 1,
            api: 'openai-completions',
            provider: 'deepseek',
            model: 'deepseek-flash',
            stopReason: 'length',
            blocks: [{ type: 'text' }, { type: 'tool-call' }],
          },
        },
      },
    })
    const continued = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      messages: [
        poisoned,
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
      ],
    })
    expect(continued.finish).toEqual({ kind: 'stop' })
    expect(continued.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests[0]).toMatchObject({
      messages: [
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue' },
      ],
    })
  })
})

/**
 * The desktop Hub contributes its model routes through the adapter instead of a
 * patch overlay, so the user's own settings section stays editable and both
 * families serve. These cases drive the real Loader, settings service, and config
 * editor: the same save path the Models page uses.
 */
describe('llm-pi-ai managed provider set', () => {
  /** The two providers a Hub delivery names. */
  const HUB_ROUTE = {
    displayName: 'DSH Hub',
    api: 'openai-completions',
    baseURL: 'https://hub.example/v1',
    apiKeyEnv: 'HUB_MK_HUB',
    models: [{ id: 'deepseek-v4.1-flash@relay', name: 'DeepSeek V4.1 Flash' }],
  }

  it('registers the contributed routes beside the user settings and marks them read-only', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      personal:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      '        api: openai-completions',
      `        baseURL: ${server.url}`,
      '        models:',
      '          - id: personal-model',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['personal'])
    }, { timeout: 5000 })

    const slot = ctx.llmPiAiManaged.contribute('hub')
    slot.replace({ hub: HUB_ROUTE })
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['hub', 'personal'])
    }, { timeout: 5000 })

    const directory = ctx.llm.listConfigurableProviders()
    expect(directory.find(entry => entry.provider === 'hub')).toMatchObject({ managed: true, displayName: 'DSH Hub' })
    expect(directory.find(entry => entry.provider === 'personal')?.managed).toBeUndefined()
    // The settings form still describes only the user's own section.
    const descriptor = ctx.settings.describe().find(row => row.ns === 'llm-pi-ai')
    expect(Object.keys((descriptor?.value as { providers?: object }).providers ?? {})).toEqual(['personal'])
  })

  it('serves both families from their own endpoints and credentials', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const personalServer = await mockServer([{ events: textEvents }])
    const hubServer = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      personal:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      '        api: openai-completions',
      `        baseURL: ${personalServer.url}`,
      '        models:',
      '          - id: personal-model',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['personal'])
    }, { timeout: 5000 })
    ctx.llmPiAiManaged.contribute('hub').replace({ hub: { ...HUB_ROUTE, baseURL: hubServer.url } })
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['hub', 'personal'])
    }, { timeout: 5000 })

    await assemble(ctx, { provider: 'personal', model: 'personal-model', messages: [] })
    await assemble(ctx, { provider: 'hub', model: 'deepseek-v4.1-flash@relay', messages: [] })
    // Each request reached its own listener with its own test credential.
    expect(personalServer.paths).toEqual(['/chat/completions'])
    expect(personalServer.headers[0]?.authorization).toBe('Bearer key-from-store')
    expect(hubServer.paths).toEqual(['/chat/completions'])
    expect(hubServer.headers[0]?.authorization).toBe('Bearer hub-relay-key')
  })

  it('refuses a personal route that collides with a managed one, and keeps serving both sets', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const { ctx } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    ctx.llmPiAiManaged.contribute('hub').replace({ hub: HUB_ROUTE })
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['hub'])
    }, { timeout: 5000 })

    // The Models page saving a personal provider under the Hub's route key.
    await expect(ctx.settings.mutate('llm-pi-ai', [
      {
        op: 'set',
        path: ['providers', 'hub'],
        value: {
          apiKeyEnv: 'PI_COMPOSITION_KEY', api: 'openai-completions', baseURL: 'https://personal.example/v1',
          models: [{ id: 'personal-model' }],
        },
      },
    ])).rejects.toThrow(/managed by another source/u)
    // The refusal changed nothing: the Hub route still serves.
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['hub'])
  })

  it('refuses a managed route that collides with the user, keeps the previous set, and withdraws cleanly', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const { ctx, settingsPath } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      personal:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      '        api: openai-completions',
      '        baseURL: https://personal.example/v1',
      '        models:',
      '          - id: personal-model',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['personal'])
    }, { timeout: 5000 })

    const slot = ctx.llmPiAiManaged.contribute('hub')
    slot.replace({ hub: HUB_ROUTE })
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['hub', 'personal'])
    }, { timeout: 5000 })
    // The Hub later delivers a route the user already owns: the whole replacement
    // is refused, so the working Hub set and the user's route both stay.
    expect(() => {
      slot.replace({ hub: HUB_ROUTE, personal: { ...HUB_ROUTE, displayName: 'Hub Personal' } })
    }).toThrow(/collides with a provider the user configured/u)
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['hub', 'personal'])
    // A malformed replacement is refused the same way.
    expect(() => { slot.replace({ hub: { api: 'not-a-protocol' } }) }).toThrow(/cannot be served|not valid/u)
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['hub', 'personal'])

    // Signing out withdraws the Hub routes and leaves the user's own route serving.
    slot.withdraw()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['personal'])
    slot.replace({ hub: HUB_ROUTE })
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['hub', 'personal'])
    }, { timeout: 5000 })
  })

  it('adds a personal provider through the real save path while a Hub set is contributed', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    ctx.llmPiAiManaged.contribute('hub').replace({ hub: HUB_ROUTE })
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['hub'])
    }, { timeout: 5000 })

    await ctx.settings.mutate('llm-pi-ai', [
      {
        op: 'set',
        path: ['providers', 'personal'],
        value: { apiKeyEnv: 'PI_COMPOSITION_KEY', api: 'openai-completions', baseURL: server.url, models: [{ id: 'personal-model' }] },
      },
    ])
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['hub', 'personal'])
    }, { timeout: 5000 })
    expect(Object.keys((ctx.settings.describe().find(row => row.ns === 'llm-pi-ai')?.value as { providers: object }).providers))
      .toEqual(['personal'])
    await assemble(ctx, { provider: 'personal', model: 'personal-model', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
  })
})

/**
 * The managed contribution's life and transaction, over the real adapter service.
 *
 * A connector instance owns one slot; the composition can unload and re-create it
 * while this adapter keeps serving, so contribution has to end cleanly and start
 * again. A replacement that the live LLM registry cannot serve — another adapter's
 * route or another plugin's directory entry — must fail the whole set and leave the
 * previous routes registered and callable.
 */
describe('llm-pi-ai managed provider lifecycle (rework)', () => {
  const HUB_ROUTE = {
    displayName: 'DSH Hub',
    api: 'openai-completions',
    baseURL: 'https://hub.example/v1',
    apiKeyEnv: 'HUB_MK_HUB',
    models: [{ id: 'hub-model', name: 'Hub Model' }],
  }

  /** A plugin shaped like the connector: one slot, released with its fiber. */
  function connectorPlugin(onMounted: () => void) {
    return {
      name: 'test-managed-contributor',
      apply: (child: Context) => {
        child.inject(['llmPiAiManaged'], (scope) => {
          const slot = scope.llmPiAiManaged.contribute('hub')
          let released = false
          scope.effect(() => {
            slot.replace({ hub: HUB_ROUTE })
            onMounted()
            return () => {
              if (released) return
              released = true
              slot.release()
            }
          })
        })
      },
    }
  }

  it('releases its slot so a recomposed contributor can contribute and register again', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const { ctx } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    let mounts = 0
    const first = await ctx.plugin(connectorPlugin(() => { mounts += 1 }))
    expect(mounts).toBe(1)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['hub'])
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'hub')?.managed).toBe(true)

    // The composition unloads the connector while this adapter keeps running.
    await first.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders().some(entry => entry.provider === 'hub')).toBe(false)

    // A new connector instance holds the same source name and registers again.
    const second = await ctx.plugin(connectorPlugin(() => { mounts += 1 }))
    expect(mounts).toBe(2)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['hub'])
    await second.dispose()
  })

  it('refuses a released slot and frees the name for a new contribute', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const { ctx } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    const slot = ctx.llmPiAiManaged.contribute('hub')
    slot.replace({ hub: HUB_ROUTE })
    slot.release()
    expect(() => { slot.replace({ hub: HUB_ROUTE }) }).toThrow(/was released/u)
    expect(() => { slot.withdraw() }).toThrow(/was released/u)
    const again = ctx.llmPiAiManaged.contribute('hub')
    again.replace({ hub: HUB_ROUTE })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['hub'])
  })

  it('refuses a set whose route another adapter already serves and keeps the old routes callable', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    const slot = ctx.llmPiAiManaged.contribute('hub')
    slot.replace({ hub: { ...HUB_ROUTE, baseURL: server.url } })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['hub'])

    class ForeignAdapter extends LlmAdapter {
      override async *stream(): AsyncIterable<never> {
        throw new Error('the foreign adapter serves no request in this test')
      }
    }
    const foreign = ctx.llm.registerAdapter(['foreign-route'], new ForeignAdapter())
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['foreign-route', 'hub'])

    expect(() => {
      slot.replace({
        hub: { ...HUB_ROUTE, baseURL: server.url },
        'foreign-route': HUB_ROUTE,
      })
    }).toThrow(/already served by another adapter/u)
    // The refused set changed nothing; the previous Hub route still answers.
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['foreign-route', 'hub'])
    expect(ctx.llmPiAiManaged.snapshot().routes).toEqual(new Set(['hub']))
    await assemble(ctx, { provider: 'hub', model: 'hub-model', messages: [] })
    expect(server.paths).toEqual(['/chat/completions'])

    // The foreign adapter going away makes the same set registerable.
    foreign()
    slot.replace({ hub: { ...HUB_ROUTE, baseURL: server.url }, 'foreign-route': { ...HUB_ROUTE, baseURL: server.url } })
    expect(ctx.llmPiAiManaged.snapshot().routes).toEqual(new Set(['hub', 'foreign-route']))
  })

  it('refuses a set whose provider another plugin already declares in the directory', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    const slot = ctx.llmPiAiManaged.contribute('hub')
    slot.replace({ hub: { ...HUB_ROUTE, baseURL: server.url } })
    const other = ctx.llm.registerConfigurableProviders([{
      provider: 'other-plugin-route',
      displayName: 'Other Plugin',
      settingsNs: 'other-plugin',
      settingsPath: ['providers', 'other-plugin-route'],
    }])

    expect(() => {
      slot.replace({
        hub: { ...HUB_ROUTE, baseURL: server.url },
        'other-plugin-route': HUB_ROUTE,
      })
    }).toThrow(/already declared by another plugin/u)
    // Nothing moved: the old route still serves requests and the directory still
    // names this plugin's route as managed and the other plugin's route as its own.
    expect(ctx.llmPiAiManaged.snapshot().routes).toEqual(new Set(['hub']))
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'hub')?.managed).toBe(true)
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'other-plugin-route')?.settingsNs)
      .toBe('other-plugin')
    await assemble(ctx, { provider: 'hub', model: 'hub-model', messages: [] })
    expect(server.paths).toEqual(['/chat/completions'])

    other()
    slot.replace({
      hub: { ...HUB_ROUTE, baseURL: server.url },
      'other-plugin-route': { ...HUB_ROUTE, baseURL: server.url },
    })
    expect(ctx.llmPiAiManaged.snapshot().routes).toEqual(new Set(['hub', 'other-plugin-route']))
  })

  it('detaches every snapshot from the registry state', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const { ctx } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    const slot = ctx.llmPiAiManaged.contribute('hub')
    slot.replace({ hub: HUB_ROUTE })
    const first = ctx.llmPiAiManaged.snapshot()
    expect(first.providers.hub?.displayName).toBe('DSH Hub')
    // Mutating one snapshot cannot reach the registry or the next snapshot.
    const mutable = first.providers.hub as { displayName: string }
    mutable.displayName = 'mutated'
    const routes = first.routes as Set<string>
    routes.add('injected')
    const second = ctx.llmPiAiManaged.snapshot()
    expect(second.providers.hub?.displayName).toBe('DSH Hub')
    expect(second.routes).toEqual(new Set(['hub']))
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['hub'])
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'hub')?.displayName).toBe('DSH Hub')
  })
})

/**
 * Registration facts are captured when a route is registered, so the transaction
 * must expose the candidate configuration to the adapter and re-register when a
 * same-route display name or retry policy changes — not only when route keys change.
 */
describe('llm-pi-ai managed registration facts', () => {
  /** The bounded retry count the registry captured for the hub route. */
  function hubMaxRetries(ctx: Context): number | undefined {
    const policy = ctx.llm.providerRetryPolicy('hub')
    return policy.mode === 'normal' ? policy.maxRetries : undefined
  }

  const HUB_ROUTE = {
    displayName: 'Hub Initial',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:1/v1',
    apiKeyEnv: 'HUB_MK_HUB',
    models: [{ id: 'fixture-model', name: 'Fixture' }],
    retryPolicy: { mode: 'normal', maxRetries: 0 },
  }

  it('registers the candidate display name and retry policy on the first commit', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const { ctx } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    const slot = ctx.llmPiAiManaged.contribute('hub')
    slot.replace({ hub: HUB_ROUTE })
    // The adapter captured the NAME, not the route key, and the route's own policy.
    expect(ctx.llm.listProviders().find(provider => provider.id === 'hub')?.name).toBe('Hub Initial')
    expect(hubMaxRetries(ctx)).toBe(0)
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'hub')?.displayName)
      .toBe('Hub Initial')
  })

  it('re-registers when the same route changes its display name or retry policy', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const { ctx } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    const slot = ctx.llmPiAiManaged.contribute('hub')
    slot.replace({ hub: HUB_ROUTE })
    expect(hubMaxRetries(ctx)).toBe(0)

    slot.replace({
      hub: { ...HUB_ROUTE, displayName: 'Hub Changed', retryPolicy: { mode: 'normal', maxRetries: 2 } },
    })
    expect(ctx.llm.listProviders().find(provider => provider.id === 'hub')?.name).toBe('Hub Changed')
    expect(hubMaxRetries(ctx)).toBe(2)
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'hub')?.displayName)
      .toBe('Hub Changed')
  })

  it('restores routes, facts, directory, snapshot, and revision when the directory replace fails', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    const slot = ctx.llmPiAiManaged.contribute('hub')
    const route = { ...HUB_ROUTE, baseURL: server.url }
    slot.replace({ hub: route })
    const revision = ctx.llmPiAiManaged.snapshot().revision
    const foreign = ctx.llm.registerConfigurableProviders([{
      provider: 'taken-route',
      displayName: 'Taken Route',
      settingsNs: 'other-plugin',
      settingsPath: ['providers', 'taken-route'],
    }])

    // Fault injection: the forward ownership pre-check cannot see the foreign
    // directory entry, so the rejection comes from the real directory replace —
    // after the new routes were already registered.
    const original = ctx.llm.listConfigurableProviders.bind(ctx.llm)
    let calls = 0
    ctx.llm.listConfigurableProviders = () => (calls++ === 0
      ? original().filter(entry => entry.provider !== 'taken-route')
      : original())

    expect(() => {
      slot.replace({
        hub: { ...route, displayName: 'Hub Changed', retryPolicy: { mode: 'normal', maxRetries: 2 } },
        'taken-route': route,
      })
    }).toThrow(/directory entry could not be registered/u)
    ctx.llm.listConfigurableProviders = original

    // Everything the failed commit touched is back to the last good commit.
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['hub'])
    expect(ctx.llm.listProviders().find(provider => provider.id === 'hub')?.name).toBe('Hub Initial')
    expect(hubMaxRetries(ctx)).toBe(0)
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'hub')?.displayName)
      .toBe('Hub Initial')
    expect(ctx.llmPiAiManaged.snapshot().routes).toEqual(new Set(['hub']))
    expect(ctx.llmPiAiManaged.snapshot().revision).toBe(revision)
    await assemble(ctx, { provider: 'hub', model: 'fixture-model', messages: [] })
    expect(server.paths).toEqual(['/chat/completions'])

    // Once the foreign entry is gone, the same change commits and captures the
    // new facts.
    foreign()
    slot.replace({
      hub: { ...route, displayName: 'Hub Changed', retryPolicy: { mode: 'normal', maxRetries: 2 } },
      'taken-route': route,
    })
    expect(ctx.llm.listProviders().find(provider => provider.id === 'hub')?.name).toBe('Hub Changed')
    expect(hubMaxRetries(ctx)).toBe(2)
    expect(ctx.llmPiAiManaged.snapshot().routes).toEqual(new Set(['hub', 'taken-route']))
  })

  it('keeps the failed attempt from touching the registered facts or the directory', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const { ctx } = await loadComposition({ HUB_MK_HUB: 'hub-relay-key' })
    const slot = ctx.llmPiAiManaged.contribute('hub')
    slot.replace({ hub: HUB_ROUTE })
    const other = ctx.llm.registerConfigurableProviders([{
      provider: 'other-plugin-route',
      displayName: 'Other Plugin',
      settingsNs: 'other-plugin',
      settingsPath: ['providers', 'other-plugin-route'],
    }])

    // The same hub route changes its facts, but the set also names a route another
    // plugin owns: the whole transaction must be refused.
    expect(() => {
      slot.replace({
        hub: { ...HUB_ROUTE, displayName: 'Hub Changed', retryPolicy: { mode: 'normal', maxRetries: 2 } },
        'other-plugin-route': HUB_ROUTE,
      })
    }).toThrow(/already declared by another plugin/u)
    // Every captured fact and the directory still describe the previous commit.
    expect(ctx.llm.listProviders().find(provider => provider.id === 'hub')?.name).toBe('Hub Initial')
    expect(hubMaxRetries(ctx)).toBe(0)
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'hub')?.displayName)
      .toBe('Hub Initial')
    expect(ctx.llmPiAiManaged.snapshot().routes).toEqual(new Set(['hub']))
    other()
    slot.replace({
      hub: { ...HUB_ROUTE, displayName: 'Hub Changed', retryPolicy: { mode: 'normal', maxRetries: 2 } },
    })
    expect(ctx.llm.listProviders().find(provider => provider.id === 'hub')?.name).toBe('Hub Changed')
    expect(hubMaxRetries(ctx)).toBe(2)
  })
})
