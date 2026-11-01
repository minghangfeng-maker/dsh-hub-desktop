/**
 * The shell's side of the connector's restart record.
 *
 * The connector cannot restart the application, so it records the need; these cases
 * pin when the shell may offer the restart (a record from this run, after its sync
 * round settled), that a dismissal is honoured for the rest of the run, and that a
 * request from the account card restarts once.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { decideHubRestart, DesktopHubRestartWatcher, readHubRestartSnapshot, type HubRestartSnapshot } from '../src/hub-restart.ts'

const RUN_STARTED = '2026-10-23T01:00:00.000Z'
const RECORDED = '2026-10-23T01:00:05.000Z'
const SETTLED = '2026-10-23T01:00:06.000Z'

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One connector snapshot with the pending restart that this run recorded. */
function snapshot(overrides: Partial<{ restart: HubRestartSnapshot['restart']; syncedAt: string | null }> = {}): HubRestartSnapshot {
  return {
    restart: { reason: 'configuration changed', at: RECORDED, boot: 'boot-1' },
    syncedAt: SETTLED,
    ...overrides,
  }
}

/** Write one connector state document into a fresh profile. */
function profile(state: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hub-restart-'))
  roots.push(root)
  mkdirSync(join(root, 'desktop-hub'), { recursive: true })
  writeFileSync(join(root, 'desktop-hub', 'state.json'), JSON.stringify(state))
  return root
}

it('offers the restart only for a record this run wrote after its sync round settled', () => {
  const memory = { since: RUN_STARTED, promptAt: null, requestAt: null }
  expect(decideHubRestart(snapshot(), memory)).toEqual({ kind: 'prompt', restart: snapshot().restart })
  // A record an earlier run wrote is already composed by this start.
  expect(decideHubRestart(snapshot({ restart: { reason: 'configuration changed', at: '2026-10-22T20:00:00.000Z', boot: 'boot-0' } }), memory))
    .toEqual({ kind: 'idle' })
  // The background dependency pass has not finished, so the profile is still moving.
  expect(decideHubRestart(snapshot({ syncedAt: null }), memory)).toEqual({ kind: 'idle' })
  expect(decideHubRestart(snapshot({ syncedAt: '2026-10-23T01:00:04.000Z' }), memory)).toEqual({ kind: 'idle' })
  // A dismissal is remembered for this record.
  expect(decideHubRestart(snapshot(), { ...memory, promptAt: RECORDED })).toEqual({ kind: 'idle' })
  // A later manifest application is a new record, settled by its own round, and offered again.
  const next = snapshot({
    restart: { reason: 'a plugin needs a restart', at: '2026-10-23T02:00:00.000Z', boot: 'boot-1' },
    syncedAt: '2026-10-23T02:00:01.000Z',
  })
  expect(decideHubRestart(next, { ...memory, promptAt: RECORDED })).toEqual({ kind: 'prompt', restart: next.restart })
})

it('restarts once for an account-card request, and only after the round settled', () => {
  const requested = snapshot({ restart: { reason: 'configuration changed', at: RECORDED, boot: 'boot-1', requestedAt: '2026-10-23T01:00:07.000Z' } })
  const memory = { since: RUN_STARTED, promptAt: RECORDED, requestAt: null }
  expect(decideHubRestart(requested, memory)).toEqual({ kind: 'restart', restart: requested.restart })
  expect(decideHubRestart(requested, { ...memory, requestAt: '2026-10-23T01:00:07.000Z' })).toEqual({ kind: 'idle' })
  expect(decideHubRestart({ ...requested, syncedAt: null }, memory)).toEqual({ kind: 'idle' })
})

it('reads the connector record and ignores a document that is not one', () => {
  const root = profile({ restart: { reason: 'configuration changed', at: RECORDED, boot: 'boot-1' }, syncedAt: SETTLED })
  expect(readHubRestartSnapshot(root)).toEqual(snapshot())
  expect(readHubRestartSnapshot(profile({ restart: { reason: 'x' } }))).toEqual({ restart: null, syncedAt: null })
  expect(readHubRestartSnapshot(profile({ 'restart': null, 'syncedAt': SETTLED }))).toEqual({ restart: null, syncedAt: SETTLED })
  expect(readHubRestartSnapshot(join(root, 'absent'))).toBeUndefined()
})

it('asks once per record and leaves a request to the restart action', async () => {
  vi.useFakeTimers()
  let current = snapshot()
  const prompt = vi.fn(async () => true)
  const restart = vi.fn(async () => undefined)
  const watcher = new DesktopHubRestartWatcher({
    profile: 'unused', since: RUN_STARTED, intervalMs: 1000, prompt, restart, read: () => current,
  })
  watcher.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(prompt).toHaveBeenCalledExactlyOnceWith('configuration changed')
  // The same record never raises a second prompt.
  await vi.advanceTimersByTimeAsync(3000)
  expect(prompt).toHaveBeenCalledOnce()
  expect(restart).not.toHaveBeenCalled()
  // The account card can still ask for the restart, and it happens once.
  current = snapshot({ restart: { reason: 'configuration changed', at: RECORDED, boot: 'boot-1', requestedAt: '2026-10-23T01:01:00.000Z' } })
  await vi.advanceTimersByTimeAsync(1000)
  expect(restart).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(3000)
  expect(restart).toHaveBeenCalledOnce()
  watcher.stop()
})

it('retries the prompt when no window could show it', async () => {
  vi.useFakeTimers()
  const prompt = vi.fn(async () => false)
  const watcher = new DesktopHubRestartWatcher({
    profile: 'unused', since: RUN_STARTED, intervalMs: 1000, prompt, restart: async () => undefined, read: () => snapshot(),
  })
  watcher.start()
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(1000)
  expect(prompt).toHaveBeenCalledTimes(2)
  watcher.stop()
  await vi.advanceTimersByTimeAsync(3000)
  expect(prompt).toHaveBeenCalledTimes(2)
})
