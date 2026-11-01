/**
 * The bridge between the outbound channel and the relay.
 *
 * These cases pin the gate that keeps the Host honest: capabilities are probed as
 * soon as the switch is on, but no adapter — and therefore no `$events` stream —
 * exists until the Hub opens a real phone channel. Switching off retires the adapter
 * and stops writing.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { attachChannelRelay } from '../../hub/plugins/hub-connector/src/channel/bridge.ts'
import { ChannelController } from '../../hub/plugins/hub-connector/src/channel/controller.ts'
import { ChannelLifecycle } from '../../hub/plugins/hub-connector/src/channel/lifecycle.ts'
import { RELAY_VERSION, type RelayAdapter, type RelayCapabilities } from '../../hub/plugins/hub-connector/src/channel/relay.ts'
import type {
  ChannelCloseEvent,
  ChannelCredentials,
  ChannelSocket,
  ChannelTransport,
} from '../../hub/plugins/hub-connector/src/channel/types.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Profile directory removed after the case. */
function profile(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-'))
  roots.push(root)
  return root
}

/** One in-memory socket the case drives. */
class FakeSocket implements ChannelSocket {
  readonly sent: string[] = []
  readonly closeReasons: string[] = []
  private readonly messages = new Set<(text: string) => void>()
  private readonly closes = new Set<(event: ChannelCloseEvent) => void>()

  send(text: string): void { this.sent.push(text) }
  close(reason: string): void {
    this.closeReasons.push(reason)
    for (const listener of [...this.closes]) listener({ code: 1000, reason })
  }

  onMessage(listener: (text: string) => void): () => void {
    this.messages.add(listener)
    return () => { this.messages.delete(listener) }
  }

  onClose(listener: (event: ChannelCloseEvent) => void): () => void {
    this.closes.add(listener)
    return () => { this.closes.delete(listener) }
  }

  /** Deliver one frame as the Hub would. */
  receive(text: string): void {
    for (const listener of [...this.messages]) listener(text)
  }

  /** @returns every envelope the desktop wrote, parsed. */
  envelopes(): { readonly type?: string; readonly capabilities?: unknown; readonly payload?: unknown }[] {
    return this.sent.map(text => JSON.parse(text) as { readonly type?: string })
  }
}

/** Transport handing out one socket. */
class FakeTransport implements ChannelTransport {
  readonly sockets: FakeSocket[] = []
  async open(): Promise<ChannelSocket> {
    const socket = new FakeSocket()
    this.sockets.push(socket)
    return socket
  }
}

const credentials: ChannelCredentials = {
  hubOrigin: 'https://hub.example',
  token: 'dsh_dev_fixture',
  nodeId: 'dev-1',
  username: 'alice',
}

const CAPABILITIES: RelayCapabilities = {
  sessions: true, history: true, send: true, stop: true,
  stream: true, questions: true, approvals: true, create: true,
}

/** Let promise chains settle. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

/**
 * Build one enabled controller over the fake transport.
 * @param options - probe result and the adapter record to fill.
 * @returns the controller, socket list, and created adapters.
 */
function setup(options: {
  readonly probe?: () => Promise<{ compatible: boolean; capabilities: RelayCapabilities; missing: readonly string[] } | null>
} = {}) {
  const transport = new FakeTransport()
  const lifecycle = new ChannelLifecycle({
    transport,
    now: () => new Date('2026-10-23T00:00:00Z'),
    random: () => 0.5,
    schedule: () => () => undefined,
  })
  const controller = new ChannelController({
    profile: profile(),
    lifecycle,
    readCredentials: () => credentials,
    now: () => new Date('2026-10-23T00:00:00Z'),
  })
  const adapters: (RelayAdapter & { dispatched: unknown[]; closings: number })[] = []
  const detach = attachChannelRelay(controller, {
    deviceId: () => credentials.nodeId,
    clientVersion: '0.3.0',
    ...options.probe === undefined ? {} : { probe: options.probe },
    adapter: async () => {
      const created = {
        dispatched: [] as unknown[],
        closings: 0,
        async dispatch(frame: unknown) { created.dispatched.push(frame) },
        async close() { created.closings += 1 },
      }
      adapters.push(created)
      return created
    },
  })
  controller.setEnabled(true)
  return { controller, detach, transport, adapters }
}

it('probes once the switch is on and reports capabilities in hello', async () => {
  const probe = vi.fn(async () => ({ compatible: true, capabilities: CAPABILITIES, missing: [] as const }))
  const { transport, adapters, controller } = setup({ probe })
  await settle()
  const socket = transport.sockets[0]!
  expect(probe).toHaveBeenCalledTimes(1)
  const hello = socket.envelopes()[0]!
  expect(hello).toMatchObject({ type: 'hello', deviceId: 'dev-1', capabilities: null })
  await vi.waitFor(() => {
    const last = socket.envelopes().at(-1)!
    expect(last).toMatchObject({ type: 'hello', capabilities: CAPABILITIES })
  })
  expect(adapters).toEqual([])
  controller.setEnabled(false)
})

it('creates the adapter only when the Hub opens a real phone channel', async () => {
  const goodProbe = async () => ({ compatible: true, capabilities: CAPABILITIES, missing: [] as const })
  const { transport, adapters, controller } = setup({ probe: goodProbe })
  await settle()
  const socket = transport.sockets[0]!
  await vi.waitFor(() => { expect(socket.envelopes().some(envelope => envelope.type === 'hello')).toBe(true) })
  expect(adapters).toEqual([])
  socket.receive(JSON.stringify({ v: RELAY_VERSION, type: 'open', channelId: 'ch-1', nodeId: 'dev-1' }))
  await vi.waitFor(() => { expect(adapters).toHaveLength(1) })
  socket.receive(JSON.stringify({ v: RELAY_VERSION, type: 'frame', channelId: 'ch-1', payload: { v: 1, type: 'sessions', requestId: 'r1' } }))
  await vi.waitFor(() => { expect(adapters[0]!.dispatched).toEqual([{ v: 1, type: 'sessions', requestId: 'r1' }]) })
  controller.setEnabled(false)
})

it('retires the adapter and stops writing when the switch goes off', async () => {
  const goodProbe = async () => ({ compatible: true, capabilities: CAPABILITIES, missing: [] as const })
  const { transport, adapters, controller } = setup({ probe: goodProbe })
  await settle()
  const socket = transport.sockets[0]!
  socket.receive(JSON.stringify({ v: RELAY_VERSION, type: 'open', channelId: 'ch-1', nodeId: 'dev-1' }))
  await vi.waitFor(() => { expect(adapters).toHaveLength(1) })
  controller.setEnabled(false)
  await vi.waitFor(() => { expect(adapters[0]!.closings).toBe(1) })
  const before = socket.sent.length
  socket.receive(JSON.stringify({ v: RELAY_VERSION, type: 'frame', channelId: 'ch-1', payload: { v: 1, type: 'sessions' } }))
  await settle()
  expect(socket.sent.length).toBe(before)
})

it('stays without capabilities and keeps trying when the probe cannot answer yet', async () => {
  const probe = vi.fn(async () => null)
  const { transport, controller } = setup({ probe })
  await settle()
  const socket = transport.sockets[0]!
  await vi.waitFor(() => { expect(probe).toHaveBeenCalledTimes(1) })
  expect(socket.envelopes().every(envelope => envelope.capabilities === null || envelope.type !== 'hello')).toBe(true)
  controller.setEnabled(false)
})
