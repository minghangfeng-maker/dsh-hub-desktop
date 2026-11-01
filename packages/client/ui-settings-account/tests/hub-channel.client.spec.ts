/**
 * The account card's phone-access row.
 *
 * The row reads a document the Host owns and writes one boolean, so these cases
 * pin the two things the card must never do: show a switch a plain browser cannot
 * have, and report a state the Host did not send.
 */

import { expect, it, vi } from 'vitest'
import { HubChannelWatcher, parseHubChannel } from '../src/client/hub-channel.ts'

/** One fetch answer the watcher can consume. */
function reply(status: number, body: unknown = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response
}

const ONLINE = {
  enabled: true,
  phase: 'online',
  detail: 'connected',
  account: 'alice',
  nodeId: 'dev-1',
  connectedAt: '2026-10-23T00:00:00.000Z',
  attempts: 0,
  nextRetryAt: null,
}

it('reads a channel document and rejects anything else', () => {
  expect(parseHubChannel(ONLINE)).toEqual({
    enabled: true,
    phase: 'online',
    detail: 'connected',
    account: 'alice',
    nodeId: 'dev-1',
    connectedAt: '2026-10-23T00:00:00.000Z',
  })
  expect(parseHubChannel({ ...ONLINE, phase: 'nonsense' })).toBeUndefined()
  expect(parseHubChannel({ ...ONLINE, enabled: 'yes' })).toBeUndefined()
  expect(parseHubChannel({ ...ONLINE, account: null, nodeId: null, connectedAt: null })).toMatchObject({ account: null, nodeId: null })
  expect(parseHubChannel(null)).toBeUndefined()
  expect(parseHubChannel({})).toBeUndefined()
})

it('drops the row when this build has no channel route', async () => {
  const published: (unknown)[] = []
  const watcher = new HubChannelWatcher((snapshot) => { published.push(snapshot) }, {
    origin: 'http://host',
    fetch: async () => reply(404),
  })
  watcher.start()
  await vi.waitFor(() => { expect(published).toEqual([undefined]) })
  watcher.dispose()
})

it('publishes each distinct state once', async () => {
  const answers = [ONLINE, { ...ONLINE, phase: 'retry', detail: 'closed-1006' }, { ...ONLINE, phase: 'retry', detail: 'closed-1006' }]
  const published: { phase?: string }[] = []
  const watcher = new HubChannelWatcher((snapshot) => { published.push(snapshot ?? {}) }, {
    origin: 'http://host',
    intervalMs: 5,
    fetch: async () => reply(200, answers.shift() ?? { ...ONLINE, phase: 'retry', detail: 'closed-1006' }),
  })
  watcher.start()
  await vi.waitFor(() => { expect(published).toHaveLength(2) })
  watcher.dispose()
  expect(published.map(snapshot => snapshot.phase)).toEqual(['online', 'retry'])
})

it('writes the switch and publishes the Host answer', async () => {
  const calls: string[] = []
  const published: { enabled?: boolean }[] = []
  const watcher = new HubChannelWatcher((snapshot) => { published.push(snapshot ?? {}) }, {
    origin: 'http://host',
    fetch: async (input, init): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(`${init?.method ?? 'GET'} ${url} ${typeof init?.body === 'string' ? init.body : ''}`)
      return reply(200, init?.method === 'POST' ? { ...ONLINE, enabled: false, phase: 'off' } : ONLINE)
    },
  })
  await watcher.setEnabled(false)
  watcher.dispose()
  expect(calls).toEqual(['POST http://host/hub-connector/api/channel {"enabled":false}'])
  expect(published).toHaveLength(1)
  expect(published[0]).toMatchObject({ enabled: false, phase: 'off', account: 'alice' })
})
