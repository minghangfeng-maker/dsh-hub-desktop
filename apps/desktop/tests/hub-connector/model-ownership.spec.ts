/**
 * Where the Hub's model routes live: connector state and the adapter, never the overlay.
 *
 * A row in `cordis.hub.patch.yml` outranks the profile patch, so the Models page
 * could not save a personal provider while a Hub row owned `llm-pi-ai`. These
 * cases pin the replacement: the delivered routes become a managed provider set
 * the connector restores across restarts, withdraws on sign-out, refuses when it
 * collides with the user, and never re-registers on a repeated delivery.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { overlayBody } from '../../hub/plugins/hub-connector/src/overlay.ts'
import { saveState } from '../../hub/plugins/hub-connector/src/state.ts'
import { PiAiManagedProviderRegistry } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  MANIFEST,
  manifestWithCompositionRow,
  recordingSlot,
  withFixture,
} from './sync-fixture.ts'

/** The provider the delivered fragment names, with this device's Hub origin. */
function hubProviders(origin: string): Record<string, unknown> {
  return {
    hub: {
      displayName: 'DSH Hub',
      api: 'openai-completions',
      baseURL: `${origin}/v1`,
      apiKeyEnv: 'HUB_MK_HUB',
      models: [{ id: 'deepseek-v4.1-flash@relay', name: 'DeepSeek V4.1 Flash' }],
    },
  }
}

it('keeps the delivered model set out of the overlay and restores it while the Hub is offline', async () => {
  await withFixture(async (fixture) => {
    const first = fixture.connect('boot-1')
    const recorded = recordingSlot()
    first.attachManagedProviderSlot(recorded.slot)
    await first.start()
    // The adapter receives the routes; the overlay carries none of them.
    expect(recorded.sets.at(-1)).toEqual(hubProviders(fixture.origin))
    expect(readFileSync(join(fixture.profile, 'cordis.hub.patch.yml'), 'utf8')).not.toContain('llm-pi-ai')
    expect(fixture.read().managedModels?.providers).toEqual(hubProviders(fixture.origin))

    // Restart into an unreachable Hub: the persisted set is what keeps Hub models
    // available, and the recorded routes are handed over before any round trip.
    fixture.offline(true)
    const second = fixture.connect('boot-2')
    const restored = recordingSlot()
    second.attachManagedProviderSlot(restored.slot)
    await second.start()
    expect(restored.sets.at(-1)).toEqual(hubProviders(fixture.origin))
    expect(fixture.read().managedModels?.providers).toEqual(hubProviders(fixture.origin))
  })
})

it('withdraws the Hub routes on sign-out and restores them on the next sign-in', async () => {
  await withFixture(async (fixture) => {
    const connector = fixture.connect('boot-1')
    const recorded = recordingSlot()
    connector.attachManagedProviderSlot(recorded.slot)
    await connector.start()
    expect(recorded.sets).toHaveLength(1)

    connector.clearAfterSignOut()
    expect(recorded.withdrawals.length).toBeGreaterThan(0)
    // The set is remembered for the next sign-in, and the user's own patch was never written.
    expect(fixture.read().managedModels?.providers).toEqual(hubProviders(fixture.origin))
    // The connector never writes the user's own patch: no personal provider, no Hub copy.
    expect(existsSync(join(fixture.profile, 'cordis.patch.yml'))).toBe(false)

    await connector.start()
    expect(recorded.sets.at(-1)).toEqual(hubProviders(fixture.origin))
  })
})

it('refuses a model set that collides with the user, keeps the previous routes, and reports partial', async () => {
  await withFixture(async (fixture) => {
    const connector = fixture.connect('boot-1')
    const recorded = recordingSlot()
    connector.attachManagedProviderSlot(recorded.slot)
    await connector.start()
    expect(fixture.read().applyState).toBe('applied')

    // The Hub delivers a route that is already a personal provider.
    const refused = recordingSlot('the managed model route "personal" from "hub" collides with a provider the user configured')
    connector.attachManagedProviderSlot(refused.slot)
    fixture.serve({
      ...MANIFEST,
      revision: 8,
      config: { fragments: [...MANIFEST.config.fragments, { id: 'dsh-memory', mode: 'enforce', config: { topK: 4 } }] },
    })
    await connector.pullManifest()
    const state = fixture.read()
    expect(state.applyState).toBe('partial')
    expect(state.applyErrorCode).toBe('config_write_failed')
    expect(state.managedModels?.providers).toEqual(hubProviders(fixture.origin))
    // The account card carries the actionable reason.
    const status = await connector.status()
    expect(status.notice).toContain('collides with a provider the user configured')
  })
})

it('adopts the Hub default only while the user has chosen nothing', async () => {
  await withFixture(async (fixture) => {
    await fixture.connect('boot-1').start()
    expect(fixture.selections).toEqual([{ provider: 'hub', model: 'deepseek-v4.1-flash@relay' }])
    expect(fixture.selected.value).toBe(true)
    // A restart keeps the user's selection: the Hub recommendation is not applied again.
    await fixture.connect('boot-2').start()
    expect(fixture.selections).toHaveLength(1)
  })
})

it('keeps a user selection that the Hub recommendation would otherwise replace', async () => {
  await withFixture(async (fixture) => {
    await fixture.connect('boot-1').start()
    const chosen = fixture.selections.at(-1)
    expect(chosen?.provider).toBe('hub')
    fixture.selected.value = true
    fixture.selections.length = 0
    // A new revision still recommends a default; the profile already has one.
    fixture.serve({ ...MANIFEST, revision: 11 })
    await fixture.connect('boot-2').start()
    expect(fixture.selections).toEqual([])
  })
})

it('imports the model routes an upgraded overlay carried, once', async () => {
  await withFixture(async (fixture) => {
    writeFileSync(join(fixture.profile, 'desktop-hub', 'legacy-models.json'), `${JSON.stringify({
      providers: hubProviders(fixture.origin),
      defaultSelection: { provider: 'hub', model: 'deepseek-v4.1-flash@relay' },
    }, undefined, 2)}\n`)
    // No manifest model rows: the Hub is offline, so only the migrated file can supply them.
    fixture.offline(true)
    const connector = fixture.connect('boot-1')
    const recorded = recordingSlot()
    connector.attachManagedProviderSlot(recorded.slot)
    await connector.start()
    expect(recorded.sets.at(-1)).toEqual(hubProviders(fixture.origin))
    expect(fixture.read().managedModels?.providers).toEqual(hubProviders(fixture.origin))
    expect(existsSync(join(fixture.profile, 'desktop-hub', 'legacy-models.json'))).toBe(false)
    expect(fixture.selections).toEqual([{ provider: 'hub', model: 'deepseek-v4.1-flash@relay' }])
  })
})

it('keeps the overlay stable across cold starts with search on, models, and an installed plugin', async () => {
  const tools = { search: true, baseUrl: 'https://hub.example/v1/tools' }
  await withFixture(async (fixture) => {
    const first = fixture.connect('boot-1')
    first.attachManagedProviderSlot(recordingSlot().slot)
    await first.start()
    const applied = fixture.read()
    const settled = overlayBody(readFileSync(join(fixture.profile, 'cordis.hub.patch.yml'), 'utf8'))
    // The derived search rows and any composition row are in the overlay; the model
    // rows are not.
    expect(settled).toContain('web-deepseek-api')
    expect(settled).toContain('deepseek-account')
    expect(settled).not.toContain('llm-pi-ai')
    fixture.calls.length = 0
    for (const boot of ['boot-2', 'boot-3', 'boot-4']) {
      const connector = fixture.connect(boot)
      connector.attachManagedProviderSlot(recordingSlot().slot)
      await connector.start()
      const state = fixture.read()
      expect(state.appliedRevision).toBe(applied.appliedRevision)
      expect(state.restart).toBeNull()
      expect(overlayBody(readFileSync(join(fixture.profile, 'cordis.hub.patch.yml'), 'utf8'))).toBe(settled)
    }
    expect(fixture.calls).toEqual([])
  }, {
    manifest: () => manifestWithCompositionRow(),
    grantTools: tools,
    installed: [{ name: '@fixture/needs-restart', version: '1.0.0', enabled: true, removable: true }],
  })
})

it('retries the same revision once the refused model set is resolved', async () => {
  await withFixture(async (fixture) => {
    const connector = fixture.connect('boot-1')
    // The adapter refuses the delivered routes (a personal route owns the id).
    connector.attachManagedProviderSlot(recordingSlot('the managed model route "hub" collides with a provider the user configured').slot)
    await connector.start()
    expect(fixture.read().appliedRevision).toBe(4)
    expect(fixture.read().applyState).toBe('partial')
    expect(fixture.read().applyErrorCode).toBe('config_write_failed')
    expect(fixture.read().managedModels).toBeNull()

    // The user renames the personal route; the Hub still serves revision 3 and its
    // conditional read now answers 304, so only the retry path can recover.
    const accepted = recordingSlot()
    connector.attachManagedProviderSlot(accepted.slot)
    await connector.pullManifest()
    const state = fixture.read()
    expect(state.appliedRevision).toBe(4)
    expect(state.applyState).toBe('applied')
    expect(state.applyErrorCode).toBeNull()
    expect(state.managedModels?.providers).toEqual(hubProviders(fixture.origin))
    expect(accepted.sets.at(-1)).toEqual(hubProviders(fixture.origin))
  })
})

it('does not republish a cached set that belongs to another account or Hub', async () => {
  // Account A delivers the set; signing out keeps it cached for A's next start.
  await withFixture(async (fixture) => {
    const first = fixture.connect('boot-1')
    const recorded = recordingSlot()
    first.attachManagedProviderSlot(recorded.slot)
    await first.start()
    expect(recorded.sets).toHaveLength(1)
    first.clearAfterSignOut()
    expect(fixture.read().managedModels?.deviceId).toBe('dv_0123456789abcdef0123456789abcdef')
  })
  // Account B on the same install, with the Hub unreachable: A's routes must not
  // appear under B before B's own delivery.
  await withFixture(async (fixture) => {
    saveState(fixture.profile, {
      ...fixture.read(),
      managedModels: {
        providers: hubProviders(fixture.origin),
        origin: fixture.origin,
        deviceId: 'dv_ffffffffffffffffffffffffffffffff',
      },
    })
    fixture.offline(true)
    const connector = fixture.connect('boot-1')
    const recorded = recordingSlot()
    connector.attachManagedProviderSlot(recorded.slot)
    await connector.start()
    expect(recorded.sets).toEqual([])
    expect(fixture.read().managedModels?.deviceId).toBe('dv_ffffffffffffffffffffffffffffffff')
  }, { grantDeviceId: 'dv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
  // A cache from another Hub origin is ignored the same way.
  await withFixture(async (fixture) => {
    saveState(fixture.profile, {
      ...fixture.read(),
      managedModels: { providers: hubProviders(fixture.origin), origin: 'https://other.example', deviceId: null },
    })
    fixture.offline(true)
    const connector = fixture.connect('boot-1')
    const recorded = recordingSlot()
    connector.attachManagedProviderSlot(recorded.slot)
    await connector.start()
    expect(recorded.sets).toEqual([])
  })
})

it('a recomposed connector takes over the same source through the real registry', async () => {
  await withFixture(async (fixture) => {
    // The real registry, with the adapter's registration transaction stubbed at the
    // seam the composition provides (route and directory registrations are covered
    // by the llm-pi-ai composition suite).
    const applied: string[][] = []
    const registry = new PiAiManagedProviderRegistry(
      () => new Set(),
      (snapshot) => { applied.push([...snapshot.routes]) },
    )
    const first = fixture.connect('boot-1')
    const firstSlot = registry.contribute('hub')
    first.attachManagedProviderSlot(firstSlot)
    await first.start()
    expect(registry.snapshot().routes).toEqual(new Set(['hub']))

    // The connector unloads: its scope detaches and releases the slot, and the
    // adapter (here: the registry) keeps running with no Hub routes.
    first.attachManagedProviderSlot(undefined)
    firstSlot.release()
    first.stop()
    expect(registry.snapshot().routes).toEqual(new Set())
    expect(() => { firstSlot.replace({ hub: hubProviders(fixture.origin) }) }).toThrow(/was released/u)

    // A recomposed connector contributes the same source name and registers again.
    const second = fixture.connect('boot-2')
    const secondSlot = registry.contribute('hub')
    second.attachManagedProviderSlot(secondSlot)
    await second.start()
    expect(registry.snapshot().routes).toEqual(new Set(['hub']))
    expect(applied.at(-1)).toEqual(['hub'])
  })
})

it('reports a real registry refusal as a failed application without losing the previous set', async () => {
  await withFixture(async (fixture) => {
    let refuse = false
    const registry = new PiAiManagedProviderRegistry(
      () => new Set(),
      (snapshot) => {
        // The adapter's registration transaction refuses the changed route set;
        // restoring the previous one succeeds, as the live adapter guarantees.
        if (refuse && snapshot.providers.hub?.displayName === 'Refused') throw new Error('adapter refused the route set')
      },
    )
    const connector = fixture.connect('boot-1')
    connector.attachManagedProviderSlot(registry.contribute('hub'))
    await connector.start()
    expect(fixture.read().applyState).toBe('applied')

    refuse = true
    fixture.serve({
      ...MANIFEST,
      revision: 6,
      config: {
        fragments: MANIFEST.config.fragments.map(fragment => fragment.id === 'llm-pi-ai'
          ? { ...fragment, config: { providers: { hub: { ...(fragment.config as { providers: Record<string, object> }).providers.hub, displayName: 'Refused' } } } }
          : fragment),
      },
    })
    await connector.pullManifest()
    const state = fixture.read()
    expect(state.applyState).toBe('partial')
    expect(state.applyErrorCode).toBe('config_write_failed')
    // The registry kept the previous set, and the connector remembers it.
    expect(state.managedModels?.providers).toEqual(hubProviders(fixture.origin))
    expect(registry.snapshot().routes).toEqual(new Set(['hub']))
    const status = await connector.status()
    expect(status.notice).toContain('adapter refused the route set')
  })
})
