/**
 * The personal model channel beside the Hub's, over the real save path.
 *
 * These cases boot the shipped `llm-pi-ai` row through a real Loader with a
 * launcher overlay — exactly how the desktop Host hands it the Hub file — and add
 * a provider through `settings.mutate`, which is what the Models page calls. The
 * first case reproduces the reported failure on the old overlay shape; the rest
 * run the same save against the overlay the desktop Host leaves after migration.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { profileComposition } from '../../../../packages/settings/settings/tests/profile-composition.ts'
import { HUB_OVERLAY_FILENAME, LEGACY_MODEL_FILE, migrateHubOverlayModels } from '../../../desktop-host/src/hub-overlay.ts'
import { renderOverlay } from '../../hub/plugins/hub-connector/src/overlay.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** The model rows an older desktop build delivered, plus a row it does not own. */
const DELIVERED_FRAGMENTS = [
  {
    id: 'llm-pi-ai',
    mode: 'enforce' as const,
    config: {
      providers: {
        hub: {
          displayName: 'DSH Hub',
          api: 'openai-completions',
          baseURL: 'https://hub.example/v1',
          apiKeyEnv: 'HUB_MK_HUB',
          models: [{ id: 'deepseek-v4.1-flash@relay', name: 'DeepSeek V4.1 Flash' }],
        },
      },
    },
  },
  { id: 'agent-default-model', mode: 'enforce' as const, config: { provider: 'hub', model: 'deepseek-v4.1-flash@relay' } },
  { id: 'deepseek-account', mode: 'enforce' as const, config: { credentialRef: 'HUB_ACCOUNT' } },
]

/** Row ids one overlay file declares. */
async function overlayRows(path: string): Promise<PatchOptions[]> {
  return yaml.load(await readFile(path, 'utf8'), { schema: entryListSchema }) as PatchOptions[]
}

/**
 * Boot the shipped rows with the launcher overlays the desktop Host passes.
 *
 * Reusing the installation root across calls is the same profile a restart opens.
 */
async function boot(overlays: readonly PatchOptions[]): Promise<{ ctx: Context; settingsPath: string; profile: string }> {
  root ??= await mkdtemp(join(tmpdir(), 'wp37-personal-channel-'))
  const credentialsPath = join(root, '.credentials.yaml')
  await writeFile(credentialsPath, 'version: 1\nrefs:\n  PI_TEST_KEY: personal-test-key\n  HUB_MK_HUB: hub-test-key\n', { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsPath)}`,
    '    debounceMs: 10',
    '- id: authorization',
    "  name: '@deepseek-ai/dsh-authorization'",
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: ""',
    '    model: ""',
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-authorization', AuthorizationService],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-agent-default-model', AgentDefaultModel],
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
  const settingsPath = await profileComposition(ctx, root, configPath, overlays)
  return { ctx, settingsPath, profile: join(root, 'profile') }
}

/** The overlay an older desktop build wrote into one profile. */
async function seedOldOverlay(profile: string): Promise<string> {
  const path = join(profile, HUB_OVERLAY_FILENAME)
  const rendered = renderOverlay({ revision: 4, fragments: DELIVERED_FRAGMENTS, connectorRow: true }, { userDeclared: new Set() })
  await writeFile(path, rendered.text, { mode: 0o600 })
  return path
}

/** The personal provider the Models page adds. */
const PERSONAL = {
  apiKeyEnv: 'PI_TEST_KEY',
  api: 'openai-completions',
  baseURL: 'https://personal.example/v1',
  models: [{ id: 'personal-large', name: 'Personal Large' }],
}

describe('personal model channel beside the Hub', () => {
  it('reproduces the refusal while the old enforce overlay owns the model row', async () => {
    const first = await boot([])
    const overlay = await seedOldOverlay(first.profile)
    // The Host passes the same file as its last --patch layer; boot again with it.
    await first.ctx.fiber.dispose()
    context = undefined
    const { ctx } = await boot(await overlayRows(overlay))
    // The overlay still owns the route: the Hub's own config is what serves.
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['hub'])
    await expect(ctx.settings.mutate('llm-pi-ai', [
      { op: 'set', path: ['providers', 'personal'], value: PERSONAL },
    ])).rejects.toThrow(/overridden by a home patch or command-line overlay/u)
  })

  it('adds a personal provider after the startup migration, with the Hub set registered separately', async () => {
    const first = await boot([])
    const overlay = await seedOldOverlay(first.profile)
    const migrated = migrateHubOverlayModels(first.profile)
    expect(migrated.removed).toEqual(['llm-pi-ai', 'agent-default-model'])
    // The row the connector does not own stays in the file.
    expect(await readFile(overlay, 'utf8')).toContain('- id: deepseek-account')
    await first.ctx.fiber.dispose()
    context = undefined
    const { ctx, settingsPath } = await boot(await overlayRows(overlay))
    // The Hub routes come from the extraction file through the adapter's managed set.
    const legacy = JSON.parse(await readFile(join(first.profile, 'desktop-hub', LEGACY_MODEL_FILE), 'utf8')) as { providers: Record<string, unknown> }
    ctx.llmPiAiManaged.contribute('hub').replace(legacy.providers)

    // The shipped rows still apply: the overlay's account row is composed, not the model row.
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['hub'])

    await ctx.settings.mutate('llm-pi-ai', [
      { op: 'set', path: ['providers', 'personal'], value: PERSONAL },
    ])
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['hub', 'personal'])
    // Only the user's own route reached the profile patch.
    const patch = await readFile(settingsPath, 'utf8')
    expect(patch).toContain('personal')
    expect(patch).not.toContain('deepseek-v4.1-flash@relay')
    // The directory marks which owner supplies each route.
    const directory = ctx.llm.listConfigurableProviders()
    expect(directory.find(entry => entry.provider === 'hub')?.managed).toBe(true)
    expect(directory.find(entry => entry.provider === 'personal')?.managed).toBeUndefined()
    // The Hub route keeps the provider and model ids old sessions reference.
    const hub = directory.find(entry => entry.provider === 'hub')
    expect(hub?.displayName).toBe('DSH Hub')
    expect(Object.keys(legacy.providers)).toEqual(['hub'])
  })

  it('persists a user default through the real save path and keeps it across a restart', async () => {
    const first = await boot([])
    const overlay = await seedOldOverlay(first.profile)
    expect(migrateHubOverlayModels(first.profile).migrated).toBe(true)
    await first.ctx.fiber.dispose()
    context = undefined
    const { ctx, settingsPath } = await boot(await overlayRows(overlay))
    const legacy = JSON.parse(await readFile(join(first.profile, 'desktop-hub', LEGACY_MODEL_FILE), 'utf8')) as { providers: Record<string, unknown> }
    ctx.llmPiAiManaged.contribute('hub').replace(legacy.providers)
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'personal'], value: PERSONAL }])
    // The picker's save path is the same config editor, and the overlay no longer wins.
    await ctx.agentDefaultModel.saveSelection({ provider: 'personal', model: 'personal-large' })
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'personal', model: 'personal-large' })
    const patch = await readFile(settingsPath, 'utf8')
    expect(patch).toContain('provider: personal')
    expect(patch).toContain('model: personal-large')

    // Restart: the same profile boots again and the user's selection survives.
    await ctx.fiber.dispose()
    context = undefined
    const restarted = await boot(await overlayRows(overlay))
    expect(restarted.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'personal', model: 'personal-large' })
    // The migrated overlay is stable: a repeated migration writes nothing.
    const before = await readFile(overlay, 'utf8')
    expect(migrateHubOverlayModels(first.profile)).toEqual({ migrated: false, removed: [] })
    expect(await readFile(overlay, 'utf8')).toBe(before)
  })
})
