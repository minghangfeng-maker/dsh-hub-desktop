/**
 * The relay wire against a real Hub-shaped socket.
 *
 * The default transport is exercised with no injected factory: a real `ws` server
 * stands in for the Hub endpoint, so the `createRequire('ws')` path, the hello frame,
 * the open/frame/close envelope, and the error answers are all the ones a phone would
 * meet. Every frame the desktop writes is checked against the Hub's envelope union —
 * a bare `bye` or `error` at the top level would make the Hub drop the whole socket.
 */

import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { attachChannelRelay } from '../../hub/plugins/hub-connector/src/channel/bridge.ts'
import { ChannelController } from '../../hub/plugins/hub-connector/src/channel/controller.ts'
import { ChannelLifecycle } from '../../hub/plugins/hub-connector/src/channel/lifecycle.ts'
import { RELAY_PATH, RELAY_VERSION, type RelayAdapter } from '../../hub/plugins/hub-connector/src/channel/relay.ts'
import { createWebSocketTransport } from '../../hub/plugins/hub-connector/src/channel/transport.ts'
import type { ChannelCredentials } from '../../hub/plugins/hub-connector/src/channel/types.ts'

const servers: WebSocketServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The Hub's envelope union, as the desktop must emit it. */
const ENVELOPE_TYPES = new Set(['hello', 'open', 'frame', 'close'])

/** One parsed frame the Hub received. */
interface HubFrame {
  readonly v?: number
  readonly type?: string
  readonly channelId?: string
  readonly payload?: unknown
  readonly deviceId?: string
  readonly capabilities?: unknown
}

/** One Hub-shaped relay server. */
async function hub(): Promise<{
  port: number
  frames: HubFrame[]
  socket: Promise<WebSocket>
  send: (frame: unknown) => void
}> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: RELAY_PATH })
  servers.push(server)
  const frames: HubFrame[] = []
  const accepted = Promise.withResolvers<WebSocket>()
  server.on('connection', (socket, request) => {
    if (request.headers.authorization !== 'Bearer fixture-token') {
      socket.close(1008, 'unauthorized')
      return
    }
    accepted.resolve(socket)
    socket.on('message', (data: { toString(): string }) => {
      frames.push(JSON.parse(data.toString()) as HubFrame)
    })
  })
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('hub: no port')
  return {
    port: address.port,
    frames,
    socket: accepted.promise,
    send(frame: unknown) {
      void accepted.promise.then((socket) => { socket.send(JSON.stringify(frame)) })
    },
  }
}

/**
 * Bring one enabled channel up against a Hub server.
 * @param port - Hub port.
 * @returns the controller, created adapters, and a disposer.
 */
function channel(port: number): {
  controller: ChannelController
  adapters: (RelayAdapter & { dispatched: unknown[]; closings: number })[]
  detach: () => void
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wire-'))
  roots.push(root)
  const credentials: ChannelCredentials = {
    hubOrigin: `http://127.0.0.1:${String(port)}`,
    token: 'fixture-token',
    nodeId: 'dev-1',
    username: 'alice',
  }
  const controller = new ChannelController({
    profile: root,
    lifecycle: new ChannelLifecycle({
      transport: createWebSocketTransport(),
      now: () => new Date(),
      random: () => 0.5,
      schedule: (delayMs, run) => {
        const timer = setTimeout(run, delayMs)
        timer.unref?.()
        return () => { clearTimeout(timer) }
      },
    }),
    readCredentials: () => credentials,
    now: () => new Date(),
  })
  const adapters: (RelayAdapter & { dispatched: unknown[]; closings: number })[] = []
  const detach = attachChannelRelay(controller, {
    deviceId: () => credentials.nodeId,
    clientVersion: '0.3.0',
    adapter: async () => {
      const created = {
        dispatched: [] as unknown[],
        closings: 0,
        async dispatch(frame: unknown) {
          created.dispatched.push(frame)
        },
        async close() {
          created.closings += 1
        },
      }
      adapters.push(created)
      return created
    },
  })
  controller.setEnabled(true)
  return { controller, adapters, detach }
}

it('greets a real Hub socket with hello and only envelope-legal frames', async () => {
  const server = await hub()
  const { controller, adapters, detach } = channel(server.port)
  const socket = await server.socket
  await vi.waitFor(() => {
    expect(server.frames.some(frame => frame.type === 'hello')).toBe(true)
  })
  const hello = server.frames.find(frame => frame.type === 'hello')!
  expect(hello).toMatchObject({ v: RELAY_VERSION, type: 'hello', deviceId: 'dev-1' })
  expect(hello.capabilities === null || typeof hello.capabilities === 'object').toBe(true)

  // The Hub opens a phone channel; the adapter is built only now.
  expect(adapters).toEqual([])
  server.send({ v: RELAY_VERSION, type: 'open', channelId: 'ch-1', nodeId: 'dev-1' })
  await vi.waitFor(() => { expect(adapters).toHaveLength(1) })

  server.send({ v: RELAY_VERSION, type: 'frame', channelId: 'ch-1', payload: { v: 1, type: 'sessions', requestId: 'r1' } })
  await vi.waitFor(() => { expect(adapters[0]!.dispatched).toHaveLength(1) })

  // A frame the relay refuses is answered inside a frame, never as a bare envelope.
  server.send({ v: RELAY_VERSION, type: 'frame', channelId: 'ch-1', payload: { v: 2, type: 'sessions' } })
  await vi.waitFor(() => {
    const answer = server.frames.find(frame => frame.type === 'frame'
      && typeof frame.payload === 'object' && frame.payload !== null
      && Reflect.get(frame.payload, 'type') === 'error')
    expect(answer).toBeDefined()
  })
  expect(server.frames.every(frame => ENVELOPE_TYPES.has(String(frame.type)))).toBe(true)

  detach()
  controller.setEnabled(false)
  socket.close()
  await once(socket, 'close').catch(() => undefined)
  expect(adapters[0]!.closings).toBe(1)
})

it('closes an unknown node with an envelope-legal close instead of dropping the socket', async () => {
  const server = await hub()
  const { controller, detach } = channel(server.port)
  await server.socket
  await vi.waitFor(() => { expect(server.frames.some(frame => frame.type === 'hello')).toBe(true) })
  server.send({ v: RELAY_VERSION, type: 'open', channelId: 'ch-9', nodeId: 'other-node' })
  await vi.waitFor(() => {
    expect(server.frames.some(frame => frame.type === 'close' && frame.channelId === 'ch-9')).toBe(true)
  })
  expect(server.frames.every(frame => ENVELOPE_TYPES.has(String(frame.type)))).toBe(true)
  detach()
  controller.setEnabled(false)
})
