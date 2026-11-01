/**
 * The sync rounds that write the Hub overlay, and the restart notice they may raise.
 *
 * A Hub login delivers the manifest that carries the desktop's default plugins and
 * configuration, but the overlay it writes only reaches the composition at the next
 * start. These cases pin what the connector records: a sync round that ends after its
 * background dependency pass, a restart notice bound to the Host process that wrote it
 * (so the next start retires it), the request the account page can add, the relay
 * address a delivered model fragment is moved to, and that replaying a
 * manifest whose plugins did not change never invents a restart need.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { overlayBody } from '../../hub/plugins/hub-connector/src/overlay.ts'
import { saveState } from '../../hub/plugins/hub-connector/src/state.ts'
import { MANIFEST, manifestWithCompositionRow, recordingSlot, restartingPlugin, withFixture } from './sync-fixture.ts'

it('records the restart with the sync round, then retires it at the next Host start', async () => {
  await withFixture(async (fixture) => {
    const first = fixture.connect('boot-1')
    const recorded = recordingSlot()
    first.attachManagedProviderSlot(recorded.slot)
    await first.start()
    const applied = fixture.read()
    expect(applied.appliedRevision).toBe(4)
    expect(applied.restart).toMatchObject({ reason: 'configuration changed', boot: 'boot-1' })
    expect(applied.restart?.requestedAt).toBeUndefined()
    // The prompt is raised only after the round ended, so its timestamp cannot precede the notice.
    expect(applied.syncedAt).not.toBeNull()
    expect(Date.parse(applied.syncedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(applied.restart?.at ?? ''))
    // The delivered relay address is moved onto the origin this device signed in to,
    // and the routes reach the adapter instead of the overlay.
    const delivered = recorded.sets.at(-1) as { hub?: { baseURL?: string } } | undefined
    expect(delivered?.hub?.baseURL).toBe(`${fixture.origin}/v1`)
    const overlay = readFileSync(join(fixture.profile, 'cordis.hub.patch.yml'), 'utf8')
    expect(overlay).not.toContain('relay.internal')
    expect(overlay).not.toContain('llm-pi-ai')
    // The account page can ask for the restart the shell performs.
    expect(first.requestRestart()).toBe(true)
    expect(fixture.read().restart?.requestedAt).toBe('2026-10-23T01:00:00.000Z')
  }, { manifest: () => manifestWithCompositionRow() })
})

it('needs no restart for a model delivery: the adapter registers those routes live', async () => {
  await withFixture(async (fixture) => {
    await fixture.connect('boot-1').start()
    expect(fixture.read().restart).toBeNull()
    // Neither model row reached the overlay, which is why personal edits stay possible.
    const overlay = readFileSync(join(fixture.profile, 'cordis.hub.patch.yml'), 'utf8')
    expect(overlay).not.toContain('llm-pi-ai')
    expect(overlay).not.toContain('agent-default-model')
  })
})

it('keeps one notice for the same need across deliveries in one Host process', async () => {
  await withFixture(async (fixture) => {
    const connector = fixture.connect('boot-1')
    await connector.start()
    const recorded = fixture.read().restart
    expect(recorded).not.toBeNull()
    // A later revision changes the rows again, so the same restart is still owed: the
    // record keeps its timestamp instead of raising a second prompt for the same need.
    fixture.serve({
      ...MANIFEST,
      revision: 5,
      config: {
        fragments: [...MANIFEST.config.fragments, { id: 'dsh-memory', mode: 'enforce', config: { topK: 4 } }],
      },
    })
    await connector.pullManifest()
    const after = fixture.read()
    expect(after.appliedRevision).toBe(5)
    expect(after.restart).toEqual(recorded)
  }, { manifest: () => manifestWithCompositionRow() })
})

it('keeps the notice across a composition reload in the same Host process', async () => {
  await withFixture(async (fixture) => {
    await fixture.connect('boot-1').start()
    const carried = fixture.read()
    expect(carried.restart).not.toBeNull()
    // A recomposition constructs the plugin again without restarting the Host.
    const reloaded = fixture.connect('boot-1')
    await reloaded.start()
    expect(fixture.read().restart).toMatchObject({ reason: 'configuration changed', boot: 'boot-1' })
  }, { manifest: () => manifestWithCompositionRow() })
})

it('drops a notice an earlier Host process wrote, because this start composed it', async () => {
  await withFixture(async (fixture) => {
    await fixture.connect('boot-1').start()
    expect(fixture.read().restart).not.toBeNull()
    const restarted = fixture.connect('boot-2')
    await restarted.start()
    expect(fixture.read().restart).toBeNull()
    expect(restarted.requestRestart()).toBe(false)
  }, { manifest: () => manifestWithCompositionRow() })
})

it('clears the notice on sign-out, because the overlay it named is gone', async () => {
  await withFixture(async (fixture) => {
    const connector = fixture.connect('boot-1')
    await connector.start()
    expect(fixture.read().restart).not.toBeNull()
    connector.clearAfterSignOut()
    expect(fixture.read().restart).toBeNull()
  }, { manifest: () => manifestWithCompositionRow() })
})

it('does not repeat the notice across cold starts once a needsRestart plugin is installed', async () => {
  await withFixture(async (fixture) => {
    // B1: the first real install of a plugin that declares `needsRestart` owes one prompt.
    await fixture.connect('boot-1').start()
    expect(fixture.read().restart).toMatchObject({ reason: '@fixture/needs-restart needs a restart', boot: 'boot-1' })
    expect(fixture.calls).toEqual([expect.stringContaining('install:file:')])
    const afterInstall = readFileSync(join(fixture.profile, 'cordis.hub.patch.yml'), 'utf8')
    fixture.calls.length = 0
    // B1/B2: the restarted app pulls the same revision for hydration three more times.
    for (const boot of ['boot-2', 'boot-3', 'boot-4']) {
      await fixture.connect(boot).start()
      const state = fixture.read()
      expect(state.appliedRevision).toBe(4)
      expect(state.restart).toBeNull()
      expect(readFileSync(join(fixture.profile, 'cordis.hub.patch.yml'), 'utf8')).toBe(afterInstall)
    }
    // Nothing was installed, removed, or toggled by the replays.
    expect(fixture.calls).toEqual([])
  }, { manifest: origin => ({ ...MANIFEST, plugins: [restartingPlugin(origin)] }) })
})

it('does not repeat the notice when only the revision or the notice moves', async () => {
  await withFixture(async (fixture) => {
    // The plugin was installed by an earlier run of this profile.
    saveState(fixture.profile, {
      ...fixture.read(),
      managed: [{ name: '@fixture/needs-restart', version: '1.0.0', source: 'hub-core', enabled: true }],
    })
    await fixture.connect('boot-1').start()
    // Neither the model rows nor an unchanged plugin list changes the composition.
    expect(fixture.read().restart).toBeNull()
    fixture.calls.length = 0
    // The notice lives in the generated header; what the composition reads is the body.
    const settled = overlayBody(readFileSync(join(fixture.profile, 'cordis.hub.patch.yml'), 'utf8'))
    for (const [index, revision] of [5, 6, 7].entries()) {
      fixture.serve({ ...MANIFEST, revision, notice: `revision ${String(revision)}`, plugins: [restartingPlugin(fixture.origin)] })
      await fixture.connect(`boot-${String(index + 2)}`).start()
      expect(fixture.read().appliedRevision).toBe(revision)
      expect(fixture.read().restart).toBeNull()
      expect(overlayBody(readFileSync(join(fixture.profile, 'cordis.hub.patch.yml'), 'utf8'))).toBe(settled)
    }
    expect(fixture.calls).toEqual([])
  }, {
    manifest: origin => ({ ...MANIFEST, plugins: [restartingPlugin(origin)] }),
    installed: [{ name: '@fixture/needs-restart', version: '1.0.0', enabled: true, removable: true }],
  })
})

it('keeps asking for a restart a later revision really needs, once, then stops', async () => {
  await withFixture(async (fixture) => {
    await fixture.connect('boot-1').start()
    // A model-only delivery asks for nothing; only composition rows do.
    expect(fixture.read().restart).toBeNull()
    // B4: a later revision moves a composition row, which is a real change.
    fixture.serve({
      ...MANIFEST,
      revision: 9,
      config: { fragments: [...MANIFEST.config.fragments, { id: 'dsh-memory', mode: 'enforce', config: { topK: 8 } }] },
    })
    const second = fixture.connect('boot-2')
    await second.start()
    const moved = fixture.read()
    expect(moved.appliedRevision).toBe(9)
    expect(moved.restart).toMatchObject({ reason: 'configuration changed', boot: 'boot-2' })
    // The restarted app composes that revision, so the next start retires it for good.
    await fixture.connect('boot-3').start()
    expect(fixture.read().restart).toBeNull()
  })
})
