/**
 * The phone channel's durable record and retry schedule.
 *
 * The record is user consent plus the account it was given to, so these cases pin
 * the two failure modes that matter: a file that survives a crash but no longer
 * matches the account, and a retry schedule that never grows past its ceiling.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { bindingMatches, createBinding, normalizeOrigin, parseBinding } from '../../hub/plugins/hub-connector/src/channel/binding.ts'
import { MAX_RETRY_MS, MIN_RETRY_MS, retryAt, retryDelay } from '../../hub/plugins/hub-connector/src/channel/backoff.ts'
import {
  channelRecordPath,
  defaultChannelRecord,
  readChannelRecord,
  switchOf,
  writeChannelRecord,
} from '../../hub/plugins/hub-connector/src/channel/store.ts'

const roots: string[] = []

/** A profile directory that is removed after the case. */
function profile(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-channel-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('defaults to off with no binding when the record is absent', () => {
  const record = readChannelRecord(profile())
  expect(record).toEqual(defaultChannelRecord())
  expect(switchOf(record)).toBe('off')
})

it('round-trips an enabled record and reads it back as on', () => {
  const root = profile()
  const binding = createBinding({ nodeId: 'dev-1', username: 'alice', hubOrigin: 'https://hub.example', at: new Date('2026-10-23T00:00:00Z') })
  writeChannelRecord(root, { enabled: true, enabledAt: '2026-10-23T00:00:00.000Z', binding })
  const record = readChannelRecord(root)
  expect(record.enabled).toBe(true)
  expect(record.binding).toEqual(binding)
  expect(switchOf(record)).toBe('on')
})

it('reads an enabled record without a binding as off, because there is nothing to reach', () => {
  const root = profile()
  writeChannelRecord(root, { enabled: true, enabledAt: '2026-10-23T00:00:00.000Z', binding: null })
  expect(readChannelRecord(root)).toEqual(defaultChannelRecord())
})

it('ignores a corrupt or older-versioned file instead of guessing at its fields', () => {
  const root = profile()
  const path = channelRecordPath(root)
  mkdirSync(join(root, 'desktop-hub'), { recursive: true })
  writeFileSync(path, '{not json', 'utf8')
  expect(readChannelRecord(root)).toEqual(defaultChannelRecord())
  writeFileSync(path, JSON.stringify({ schemaVersion: 0, enabled: true }), 'utf8')
  expect(readChannelRecord(root)).toEqual(defaultChannelRecord())
})

it('binds only the account, node, and origin the grant names', () => {
  const binding = createBinding({ nodeId: 'dev-1', username: 'alice', hubOrigin: 'https://hub.example/', at: new Date('2026-10-23T00:00:00Z') })
  expect(binding.hubOrigin).toBe('https://hub.example')
  expect(bindingMatches(binding, { nodeId: 'dev-1', username: 'alice', hubOrigin: 'https://hub.example' })).toBe(true)
  expect(bindingMatches(binding, { nodeId: 'dev-1', username: 'alice', hubOrigin: 'https://hub.example/path' })).toBe(true)
  expect(bindingMatches(binding, { nodeId: 'dev-2', username: 'alice', hubOrigin: 'https://hub.example' })).toBe(false)
  expect(bindingMatches(binding, { nodeId: 'dev-1', username: 'bob', hubOrigin: 'https://hub.example' })).toBe(false)
  expect(bindingMatches(binding, { nodeId: 'dev-1', username: 'alice', hubOrigin: 'https://other.example' })).toBe(false)
  expect(bindingMatches(undefined, { nodeId: 'dev-1', username: 'alice', hubOrigin: 'https://hub.example' })).toBe(false)
})

it('refuses a binding whose stored origin is not already normalized', () => {
  expect(parseBinding({ nodeId: 'dev-1', username: 'alice', hubOrigin: 'https://hub.example/', boundAt: '2026-10-23T00:00:00.000Z' })).toBeUndefined()
  expect(parseBinding({ nodeId: 'dev-1', username: '', hubOrigin: 'https://hub.example', boundAt: '2026-10-23T00:00:00.000Z' })).toBeUndefined()
  expect(parseBinding({ nodeId: 'dev-1', username: 'alice', hubOrigin: 'https://hub.example', boundAt: 'soon' })).toBeUndefined()
})

it('normalizes only absolute http(s) origins', () => {
  expect(normalizeOrigin('https://hub.example/path?q=1')).toBe('https://hub.example')
  expect(normalizeOrigin('http://127.0.0.1:7700')).toBe('http://127.0.0.1:7700')
  expect(normalizeOrigin('wss://hub.example')).toBe('')
  expect(normalizeOrigin('not a url')).toBe('')
})

it('grows the retry delay exponentially, halves it by jitter, and caps it', () => {
  expect(retryDelay(0, 0)).toBe(MIN_RETRY_MS / 2)
  expect(retryDelay(0, 0.999)).toBeLessThanOrEqual(MIN_RETRY_MS)
  expect(retryDelay(1, 0.999)).toBeLessThanOrEqual(MIN_RETRY_MS * 2)
  expect(retryDelay(20, 1)).toBe(MAX_RETRY_MS)
  expect(retryDelay(-3, 0.5)).toBe(retryDelay(0, 0.5))
  expect(retryAt(new Date('2026-10-23T00:00:00Z'), 1_000)).toBe('2026-10-23T00:00:01.000Z')
})
