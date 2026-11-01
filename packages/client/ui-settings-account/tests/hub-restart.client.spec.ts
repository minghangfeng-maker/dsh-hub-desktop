/**
 * The account card's Hub restart row and the watcher behind it.
 *
 * A Hub manifest that changes the profile overlay only takes effect at the next
 * start. The connector records that need and accepts a restart request, but only the
 * desktop shell can restart the application, so the card is where a user who chose
 * "later" still finds the pending restart and a button.
 */

import { expect, it, vi } from 'vitest'
import { HubRestartWatcher, pendingHubRestart } from '../src/client/hub-restart.ts'

/** One fetch answer the watcher can consume. */
function reply(status: number, body: unknown = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response
}

/** A fetch stub that answers each route from its own script. */
function server(answers: { readonly state: Response[]; readonly restart?: Response[] }) {
  const state = [...answers.state]
  const restart = [...answers.restart ?? []]
  const calls: string[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    return url.endsWith('/hub-connector/api/restart') ? restart.shift() ?? reply(404) : state.shift() ?? reply(404)
  })
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, calls }
}

it('reads a pending restart out of the connector status', () => {
  expect(pendingHubRestart({ restart: { reason: 'configuration changed', at: 'x', boot: 'b' }, syncedAt: 'y' })).toBe(true)
  expect(pendingHubRestart({ restart: null, syncedAt: 'y' })).toBe(false)
  expect(pendingHubRestart({})).toBe(false)
  expect(pendingHubRestart(null)).toBe(false)
})

it('publishes the pending flag once and stops polling a client that has no connector', async () => {
  const hub = server({ state: [reply(200, { restart: { reason: 'configuration changed' } }), reply(404)] })
  const changes: boolean[] = []
  const watcher = new HubRestartWatcher((pending) => { changes.push(pending) }, {
    origin: 'http://127.0.0.1:4080', fetch: hub.fetch,
  })
  watcher.start()
  await vi.waitFor(() => { expect(changes).toEqual([true]) })
  await watcher.refresh()
  expect(changes).toEqual([true])
  // A plain Web client answers 404 once; asking again cannot change that.
  await watcher.refresh()
  expect(hub.calls).toHaveLength(2)
  watcher.dispose()
})

it('asks the connector for the restart and reports whether it was accepted', async () => {
  const hub = server({ state: [], restart: [reply(200, {}), reply(409, {})] })
  const watcher = new HubRestartWatcher(() => undefined, { origin: 'http://127.0.0.1:4080', fetch: hub.fetch })
  expect(await watcher.requestRestart()).toBe(true)
  expect(await watcher.requestRestart()).toBe(false)
  expect(hub.calls).toEqual([
    'POST http://127.0.0.1:4080/hub-connector/api/restart',
    'POST http://127.0.0.1:4080/hub-connector/api/restart',
  ])
  watcher.dispose()
})
