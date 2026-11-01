/**
 * The relay envelope and its channel lifecycle.
 *
 * These cases pin what the Hub depends on: a `hello` that names the device and
 * nothing private, `open` gated by node identity and channel limits, frames queued
 * while the asynchronous adapter is still being built, answers carrying the channel
 * id, dispatch failures answered instead of parked, and a retired generation that
 * can no longer write.
 */

import { expect, it, vi } from 'vitest'
import {
  DesktopRelay,
  MAX_CHANNELS,
  RELAY_VERSION,
  errorEnvelope,
  helloEnvelope,
  isClientFrame,
  readRelayEnvelope,
  type RelayAdapter,
} from '../../hub/plugins/hub-connector/src/channel/relay.ts'

/** Adapter double that records what it was asked to do. */
interface AdapterDouble extends RelayAdapter {
  readonly dispatched: unknown[]
  readonly sinks: ((payload: unknown) => void)[]
  readonly closings: number
  failDispatch: boolean
}

/** Build one adapter double. */
function adapterDouble(): AdapterDouble {
  const dispatched: unknown[] = []
  const sinks: ((payload: unknown) => void)[] = []
  let closings = 0
  const record: AdapterDouble = {
    dispatched,
    sinks,
    get closings() { return closings },
    failDispatch: false,
    async dispatch(frame: unknown, send: (payload: unknown) => void) {
      if (record.failDispatch) throw new Error('adapter said no')
      dispatched.push(frame)
      sinks.push(send)
    },
    async close() {
      closings += 1
    },
  }
  return record
}

/** One relay over a captured socket writer. */
function relayWith(options: {
  readonly adapters?: AdapterDouble[]
  readonly create?: () => Promise<RelayAdapter>
} = {}) {
  const sent: string[] = []
  const queue = [...options.adapters ?? []]
  const relay = new DesktopRelay({
    deviceId: 'dev-1',
    clientVersion: '0.3.0',
    hostStatus: () => 'running',
    capabilities: () => ({
      sessions: true, history: true, send: true, stop: true,
      stream: true, questions: true, approvals: true, create: true,
    }),
    adapter: options.create ?? (async () => {
      const created = queue.shift() ?? adapterDouble()
      queue.push(created)
      return created
    }),
    send: (text) => { sent.push(text) },
  })
  return { relay, sent, next: (): string[] => sent.splice(0) }
}

/** One client frame the relay forwards. */
function frame(channelId: string, payload: unknown): string {
  return JSON.stringify({ v: RELAY_VERSION, type: 'frame', channelId, payload })
}

/** One open envelope. */
function open(channelId: string, nodeId = 'dev-1'): string {
  return JSON.stringify({ v: RELAY_VERSION, type: 'open', channelId, nodeId })
}

it('reads only the envelopes this build accepts', () => {
  expect(readRelayEnvelope({ v: RELAY_VERSION, type: 'open', channelId: 'c1', nodeId: 'n1' }))
    .toEqual({ type: 'open', channelId: 'c1', nodeId: 'n1' })
  expect(readRelayEnvelope({ v: RELAY_VERSION, type: 'frame', channelId: 'c1', payload: { v: 1 } }))
    .toEqual({ type: 'frame', channelId: 'c1', payload: { v: 1 } })
  expect(readRelayEnvelope({ v: RELAY_VERSION, type: 'close', channelId: 'c1', code: 'node-offline', reason: 'bye' }))
    .toEqual({ type: 'close', channelId: 'c1', code: 'node-offline', reason: 'bye' })
  expect(readRelayEnvelope({ v: 2, type: 'open', channelId: 'c1', nodeId: 'n1' })).toBeUndefined()
  expect(readRelayEnvelope({ v: RELAY_VERSION, type: 'open', channelId: '', nodeId: 'n1' })).toBeUndefined()
  expect(readRelayEnvelope({ v: RELAY_VERSION, type: 'open', channelId: 'x'.repeat(65), nodeId: 'n1' })).toBeUndefined()
  expect(readRelayEnvelope({ v: RELAY_VERSION, type: 'frame', channelId: 'c1' })).toBeUndefined()
  expect(readRelayEnvelope(null)).toBeUndefined()
})

it('forwards only versioned phone frames', () => {
  expect(isClientFrame({ v: RELAY_VERSION, type: 'sessions' })).toBe(true)
  expect(isClientFrame({ v: RELAY_VERSION, type: 'answer-approval', requestId: 'r' })).toBe(true)
  expect(isClientFrame({ v: RELAY_VERSION, type: 'not-a-frame' })).toBe(false)
  expect(isClientFrame({ v: 2, type: 'sessions' })).toBe(false)
  expect(isClientFrame('sessions')).toBe(false)
  expect(isClientFrame(null)).toBe(false)
})

it('greets with the device identity, host status, and no content', () => {
  const envelope = JSON.parse(helloEnvelope({
    deviceId: 'dev-1',
    clientVersion: '0.3.0',
    hostStatus: () => 'running',
    capabilities: () => null,
  })) as Record<string, unknown>
  expect(envelope).toEqual({
    v: RELAY_VERSION,
    type: 'hello',
    deviceId: 'dev-1',
    hostStatus: 'running',
    capabilities: null,
    clientVersion: '0.3.0',
  })
  expect(JSON.stringify(envelope)).not.toMatch(/token|cookie|home/u)
})

it('pushes a new hello after the probe result changes', () => {
  let capabilities: null | { sessions: boolean } = null
  const sent: string[] = []
  const relay = new DesktopRelay({
    deviceId: 'dev-1',
    clientVersion: '0.3.0',
    hostStatus: () => 'running',
    capabilities: () => capabilities as never,
    adapter: async () => adapterDouble(),
    send: (text) => { sent.push(text) },
  })
  relay.hello()
  capabilities = { sessions: true }
  relay.hello()
  expect((JSON.parse(sent[0]!) as { capabilities: unknown }).capabilities).toBeNull()
  expect((JSON.parse(sent[1]!) as { capabilities: unknown }).capabilities).toEqual({ sessions: true })
})

it('queues frames until the asynchronous adapter is ready, then dispatches in order', async () => {
  const created = adapterDouble()
  const resolve = Promise.withResolvers<RelayAdapter>()
  const { relay } = relayWith({ create: async () => await resolve.promise })
  relay.receive(open('c1'))
  relay.receive(frame('c1', { v: 1, type: 'sessions', requestId: 'r1' }))
  relay.receive(frame('c1', { v: 1, type: 'history', requestId: 'r2' }))
  expect(created.dispatched).toEqual([])
  resolve.resolve(created)
  await vi.waitFor(() => { expect(created.dispatched).toHaveLength(2) })
  expect(created.dispatched).toEqual([
    { v: 1, type: 'sessions', requestId: 'r1' },
    { v: 1, type: 'history', requestId: 'r2' },
  ])
})

it('answers the phone when the adapter cannot be built', async () => {
  const { relay, next } = relayWith({ create: async () => { throw new Error('probe failed') } })
  relay.receive(open('c1'))
  await vi.waitFor(() => {
    const answers = next().map(text => JSON.parse(text) as { type: string; channelId?: string; code?: string })
    expect(answers).toEqual([expect.objectContaining({ type: 'close', channelId: 'c1', code: 'adapter-unavailable' })])
  })
  expect(relay.openChannels).toEqual([])
})

it('refuses an open for another node and for too many channels', () => {
  const { relay, next } = relayWith()
  relay.receive(open('c1', 'other-node'))
  expect(JSON.parse(next()[0]!)).toMatchObject({ type: 'close', code: 'node-not-found' })
  for (let index = 1; index <= MAX_CHANNELS; index += 1) relay.receive(open(`c${String(index)}`))
  expect(relay.openChannels).toHaveLength(MAX_CHANNELS)
  relay.receive(open('c9'))
  expect(JSON.parse(next().at(-1)!)).toMatchObject({ type: 'close', code: 'node-busy' })
})

it('answers a malformed phone frame instead of dropping it', () => {
  const { relay, next } = relayWith()
  relay.receive(open('c1'))
  relay.receive(frame('c1', { v: 1, type: 'made-up', requestId: 'r1' }))
  type Answer = { type: string; channelId: string; payload: { type: string; requestId: string; code: string } }
  const answer = JSON.parse(next().at(-1)!) as Answer
  // The outer envelope stays hello/open/frame/close; the phone's error rides inside a frame.
  expect(answer).toMatchObject({ type: 'frame', channelId: 'c1', payload: { type: 'error', requestId: 'r1', code: 'protocol' } })
  expect(errorEnvelope({ requestId: 'r9' }, 'protocol', 'x')).toContain('"requestId":"r9"')
})

it('answers a dispatch rejection with the frame request id', async () => {
  const created = adapterDouble()
  created.failDispatch = true
  const { relay, next } = relayWith({ create: async () => created })
  relay.receive(open('c1'))
  relay.receive(frame('c1', { v: 1, type: 'sessions', requestId: 'r7' }))
  await vi.waitFor(() => {
    const answer = next().map(text => JSON.parse(text) as { type: string; payload?: { type: string; requestId?: string; code?: string } })
      .find(value => value.payload?.type === 'error')
    expect(answer).toMatchObject({ type: 'frame', payload: { type: 'error', requestId: 'r7', code: 'internal' } })
  })
})

it('routes answers back with the channel id and stops a retired generation', async () => {
  const first = adapterDouble()
  const second = adapterDouble()
  const { relay, next } = relayWith({ adapters: [first, second] })
  relay.receive(open('c1'))
  relay.receive(frame('c1', { v: 1, type: 'sessions', requestId: 'r1' }))
  await vi.waitFor(() => { expect(first.sinks).toHaveLength(1) })
  first.sinks[0]!({ v: 1, type: 'sessions', requestId: 'r1', items: [] })
  expect(JSON.parse(next()[0]!)).toMatchObject({ type: 'frame', channelId: 'c1' })

  relay.receive(JSON.stringify({ v: RELAY_VERSION, type: 'close', channelId: 'c1', code: 'node-offline', reason: 'bye' }))
  await vi.waitFor(() => { expect(first.closings).toBe(1) })
  relay.receive(open('c1'))
  relay.receive(frame('c1', { v: 1, type: 'sessions', requestId: 'r2' }))
  await vi.waitFor(() => { expect(second.sinks).toHaveLength(1) })
  const before = next().length
  // The retired adapter's writer must not reach the new generation.
  first.sinks[0]!({ v: 1, type: 'sessions', requestId: 'stale', items: [] })
  expect(next().length).toBe(before)
})

it('closes every channel when the socket is lost, exactly once', async () => {
  const first = adapterDouble()
  const second = adapterDouble()
  const { relay } = relayWith({ adapters: [first, second] })
  relay.receive(open('c1'))
  relay.receive(open('c2'))
  await relay.disconnected()
  expect(first.closings).toBe(1)
  expect(second.closings).toBe(1)
  expect(relay.openChannels).toEqual([])
  await relay.close()
  expect(first.closings).toBe(1)
})

it('cancels a channel that closes while its adapter is still being built', async () => {
  const created = adapterDouble()
  const resolve = Promise.withResolvers<RelayAdapter>()
  const { relay } = relayWith({ create: async () => await resolve.promise })
  relay.receive(open('c1'))
  relay.receive(JSON.stringify({ v: RELAY_VERSION, type: 'close', channelId: 'c1', code: 'node-offline', reason: 'bye' }))
  resolve.resolve(created)
  await vi.waitFor(() => { expect(created.closings).toBe(1) })
  expect(created.dispatched).toEqual([])
})
