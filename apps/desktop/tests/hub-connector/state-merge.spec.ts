import { describe, expect, it } from 'vitest'
import { initialState, mergeApplyRecord, type HubState } from '../../hub/plugins/hub-connector/src/state.ts'

/** Fresh state for one profile. */
function base(): HubState {
  return initialState({ osLabel: 'Windows 11', installId: 'install-1' })
}

/** State after applying revision 1 with one delivered plugin. */
function applied(): HubState {
  return {
    ...base(),
    deviceId: 'dv_1',
    managed: [{ name: '@local/probe', version: '0.1.0', source: 'hub-default', enabled: true }],
    manifestEtag: '"rev-1"',
    appliedRevision: 1,
    appliedAt: '2026-10-22T04:28:00.066Z',
    applyState: 'applied',
    restart: { reason: 'configuration changed', at: '2026-10-22T04:28:00.066Z', boot: 'boot-1' },
    lastReport: { reportedAt: '2026-10-22T04:27:57.157Z', appliedRevision: null },
  }
}

describe('durable apply record', () => {
  it('keeps the application the file records when a stale snapshot writes next', () => {
    // The recomposed connector loaded the file before the application finished.
    const stale: HubState = { ...base(), manifestEtag: '"rev-1"', lastReport: { reportedAt: '2026-10-22T04:29:10.000Z' } }
    const merged = mergeApplyRecord(stale, applied())
    expect(merged).toMatchObject({
      appliedRevision: 1,
      appliedAt: '2026-10-22T04:28:00.066Z',
      applyState: 'applied',
      managed: [{ name: '@local/probe', version: '0.1.0', source: 'hub-default', enabled: true }],
      manifestEtag: '"rev-1"',
      restart: { reason: 'configuration changed', at: '2026-10-22T04:28:00.066Z', boot: 'boot-1' },
    })
    // The stale instance carried the device identity from the file it loaded.
    expect(merged.deviceId).toBe('dv_1')
  })

  it('takes the newer report whichever side wrote it', () => {
    const stale: HubState = { ...base(), lastReport: { reportedAt: '2026-10-22T04:29:10.000Z' } }
    expect(mergeApplyRecord(stale, applied()).lastReport).toEqual({ reportedAt: '2026-10-22T04:29:10.000Z' })
    const newer: HubState = { ...applied(), lastReport: { reportedAt: '2026-10-22T04:31:00.000Z' } }
    expect(mergeApplyRecord(newer, applied()).lastReport).toEqual({ reportedAt: '2026-10-22T04:31:00.000Z' })
  })

  it('lets a newer in-memory application win over an older file', () => {
    const newer: HubState = {
      ...applied(),
      appliedRevision: 2,
      appliedAt: '2026-10-22T05:00:00.000Z',
      managed: [{ name: '@local/probe2', version: '0.2.0', source: 'hub-default', enabled: true }],
    }
    const merged = mergeApplyRecord(newer, applied())
    expect(merged).toMatchObject({ appliedRevision: 2, appliedAt: '2026-10-22T05:00:00.000Z' })
    expect(merged.managed.map(entry => entry.name)).toEqual(['@local/probe2'])
  })

  it('keeps the snapshot untouched when neither side applied anything', () => {
    const fresh = base()
    expect(mergeApplyRecord(fresh, base())).toEqual(fresh)
  })

  it('takes the device identity a fresh snapshot lacks', () => {
    const stored: HubState = { ...base(), deviceId: 'dv_9' }
    expect(mergeApplyRecord(base(), stored).deviceId).toBe('dv_9')
  })

  it('keeps a completed removal when a stale instance writes the same revision', () => {
    const waiting: HubState = { ...applied(), applySequence: 1, pendingRemovals: ['@local/probe'] }
    const completed: HubState = { ...waiting, applySequence: 2, pendingRemovals: [], managed: [], restart: null }
    // Deliberately use identical timestamps: completion order is explicit.
    expect(mergeApplyRecord(waiting, completed)).toMatchObject({
      applySequence: 2, pendingRemovals: [], managed: [], restart: null,
    })
    expect(mergeApplyRecord(completed, waiting)).toMatchObject({
      applySequence: 2, pendingRemovals: [], managed: [], restart: null,
    })
  })
})
