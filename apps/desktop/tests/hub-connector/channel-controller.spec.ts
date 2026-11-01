/**
 * Connection lifetime and consent rules of the phone channel.
 *
 * These cases drive the switch, the account binding, and the socket through an
 * injected transport and scheduler, so they assert the product rules without a
 * network, a Host, or a real Hub: nothing connects while the switch is off, a
 * closed socket retries on the documented schedule, and signing out cannot leave
 * the previous account's consent behind.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ChannelController } from '../../hub/plugins/hub-connector/src/channel/controller.ts'
import { ChannelLifecycle } from '../../hub/plugins/hub-connector/src/channel/lifecycle.ts'
import { ChannelTransportError } from '../../hub/plugins/hub-connector/src/channel/transport.ts'
import { readChannelRecord } from '../../hub/plugins/hub-connector/src/channel/store.ts'
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
  const root = mkdtempSync(join(tmpdir(), 'dsh-channel-'))
  roots.push(root)
  return root
}

/** One in-memory socket the case drives. */
class FakeSocket implements ChannelSocket {
  readonly sent: string[] = []
  readonly closeReasons: string[] = []
  private readonly messages = new Set<(text: string) => void>()
  private readonly closes = new Set<(event: ChannelCloseEvent) => void>()

  send(text: string): void {
    this.sent.push(text)
  }

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

  /** End the connection as the Hub (or a network drop) would. */
  drop(code: number, reason: string): void {
    for (const listener of [...this.closes]) listener({ code, reason })
  }
}

/** Transport recording every attempt. */
class FakeTransport implements ChannelTransport {
  readonly attempts: { credentials: ChannelCredentials; signal: AbortSignal }[] = []
  readonly sockets: FakeSocket[] = []
  failure: Error | undefined

  async open(request: { credentials: ChannelCredentials; signal: AbortSignal }): Promise<ChannelSocket> {
    this.attempts.push(request)
    if (this.failure !== undefined) throw this.failure
    const socket = new FakeSocket()
    this.sockets.push(socket)
    return socket
  }
}

/** One armed retry the case can fire by hand. */
interface PendingRetry {
  readonly delayMs: number
  readonly run: () => void
  cancelled: boolean
}

const credentials: ChannelCredentials = {
  hubOrigin: 'https://hub.example',
  token: 'dsh_dev_fixture',
  nodeId: 'dev-1',
  username: 'alice',
}

/** Let the lifecycle's promise chain settle. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

/**
 * Build a controller over the fake transport.
 * @param options - profile directory, current grant, and the retry list to fill.
 * @returns the controller, lifecycle, transport, and retry list.
 */
function setup(options: {
  readonly profile: string
  readonly grant: ChannelCredentials | undefined
  readonly retries?: PendingRetry[]
}): {
  controller: ChannelController
  lifecycle: ChannelLifecycle
  transport: FakeTransport
  retries: PendingRetry[]
  setGrant: (next: ChannelCredentials | undefined) => void
} {
  const retries = options.retries ?? []
  const transport = new FakeTransport()
  let grant = options.grant
  const lifecycle = new ChannelLifecycle({
    transport,
    now: () => new Date('2026-10-23T00:00:00Z'),
    random: () => 0.5,
    schedule: (delayMs, run) => {
      const entry: PendingRetry = { delayMs, run, cancelled: false }
      retries.push(entry)
      return () => { entry.cancelled = true }
    },
  })
  const controller = new ChannelController({
    profile: options.profile,
    lifecycle,
    readCredentials: () => grant,
    now: () => new Date('2026-10-23T00:00:00Z'),
  })
  return { controller, lifecycle, transport, retries, setGrant: (next) => { grant = next } }
}

it('opens no connection while the switch is off, even with an account bound', async () => {
  const { controller, transport } = setup({ profile: profile(), grant: credentials })
  await settle()
  expect(controller.status()).toMatchObject({ enabled: false, phase: 'off', detail: 'user-disabled' })
  expect(transport.attempts).toEqual([])
})

it('refuses to turn on before an account is bound', async () => {
  const { controller, transport } = setup({ profile: profile(), grant: undefined })
  const status = controller.setEnabled(true)
  await settle()
  expect(status.enabled).toBe(false)
  expect(transport.attempts).toEqual([])
})

it('connects once when a bound account turns the switch on', async () => {
  const { controller, transport } = setup({ profile: profile(), grant: credentials })
  const status = controller.setEnabled(true)
  await settle()
  expect(status.enabled).toBe(true)
  expect(transport.attempts).toHaveLength(1)
  expect(transport.attempts[0]?.credentials).toEqual(credentials)
  expect(controller.status()).toMatchObject({ phase: 'online', connectedAt: '2026-10-23T00:00:00.000Z' })
})

it('delivers frames from the socket to the attached sink', async () => {
  const { controller, transport } = setup({ profile: profile(), grant: credentials })
  const frames: string[] = []
  const detach = controller.attachFrames((text) => { frames.push(text) })
  controller.setEnabled(true)
  await settle()
  transport.sockets[0]?.receive('{"type":"ready"}')
  expect(frames).toEqual(['{"type":"ready"}'])
  detach()
  transport.sockets[0]?.receive('{"type":"item"}')
  expect(frames).toEqual(['{"type":"ready"}'])
})

it('retries a closed socket on the capped schedule and reconnects', async () => {
  const { controller, transport, retries } = setup({ profile: profile(), grant: credentials })
  controller.setEnabled(true)
  await settle()
  transport.sockets[0]?.drop(1006, 'network-drop')
  expect(controller.status()).toMatchObject({ phase: 'retry', attempts: 1, detail: 'network-drop' })
  expect(retries).toHaveLength(1)
  expect(retries[0]?.delayMs).toBeGreaterThanOrEqual(500)
  expect(retries[0]?.delayMs).toBeLessThanOrEqual(1_000)
  retries[0]?.run()
  await settle()
  expect(transport.attempts).toHaveLength(2)
  expect(controller.status()).toMatchObject({ phase: 'online', attempts: 0 })
})

it('cancels the pending retry and closes the socket when the switch goes off', async () => {
  const { controller, transport, retries } = setup({ profile: profile(), grant: credentials })
  controller.setEnabled(true)
  await settle()
  transport.sockets[0]?.drop(1006, 'network-drop')
  const status = controller.setEnabled(false)
  expect(status).toMatchObject({ phase: 'off', enabled: false, nextRetryAt: null })
  expect(retries[0]?.cancelled).toBe(true)
  expect(transport.attempts).toHaveLength(1)
})

it('turns the switch off and clears the binding when the account signs out', async () => {
  const root = profile()
  const { controller, setGrant } = setup({ profile: root, grant: credentials })
  controller.setEnabled(true)
  await settle()
  setGrant(undefined)
  controller.refresh()
  expect(controller.status()).toMatchObject({ enabled: false, phase: 'off' })
  const record = readChannelRecord(root)
  expect(record.enabled).toBe(false)
  expect(record.binding).toBeNull()
})

it('replaces the binding and stops the channel when a different account appears', async () => {
  const root = profile()
  const first = setup({ profile: root, grant: credentials })
  first.controller.setEnabled(true)
  await settle()
  expect(readChannelRecord(root).enabled).toBe(true)
  first.controller.dispose()

  const second = setup({ profile: root, grant: { ...credentials, username: 'bob', nodeId: 'dev-2' } })
  const status = second.controller.status()
  expect(status).toMatchObject({ enabled: false, phase: 'off', account: 'bob', nodeId: 'dev-2' })
  expect(second.transport.attempts).toEqual([])
  expect(readChannelRecord(root)).toMatchObject({ enabled: false, binding: { username: 'bob', nodeId: 'dev-2' } })
})

it('resumes a stored switch only for the account that gave it', async () => {
  const root = profile()
  const first = setup({ profile: root, grant: credentials })
  first.controller.setEnabled(true)
  await settle()
  first.controller.dispose()

  const again = setup({ profile: root, grant: credentials })
  await settle()
  expect(again.controller.status().enabled).toBe(true)
  expect(again.transport.attempts).toHaveLength(1)
})

it('reports a missing transport instead of retrying forever', async () => {
  const { controller, transport } = setup({ profile: profile(), grant: credentials })
  transport.failure = new ChannelTransportError('transport-unavailable', 'no ws')
  controller.setEnabled(true)
  await settle()
  expect(controller.status()).toMatchObject({ phase: 'failed', detail: 'transport-unavailable', nextRetryAt: null })
})
