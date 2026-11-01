/**
 * Can an owner client answer `approval/request` over the real mux?
 *
 * This is the evidence behind `mobile-plan/M3-审批探针.md`: a real Host
 * composition (WebServer + Connection + Typert registry + Remote access +
 * Gateway + the application's own forwarded-event allowlist) with real browser
 * cookies, two independent Client connections, and the exact waterfall call the
 * approval service makes (`packages/interaction/user-approval/src/index.ts:281-283`,
 * tail `() => 'unavailable'`).
 *
 * Nothing here weakens the owner-only waterfall rule: a non-owner Peer has no
 * `$events` route at all, and every case below runs as the owner a browser
 * connection already is.
 */

import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { API_REMOTE_FORWARDED_EVENTS, apply as applyApiRemotes } from '@deepseek-ai/dsh-api-remotes'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import WebSocket from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { browserCookie, provideBrowserCredentials } from '../../../../packages/api/gateway/tests/browser-credentials.ts'

const roots: Context[] = []

afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
})

/**
 * Compose a real Host with the application's forwarded-event allowlist.
 * @returns the Host context and its origin.
 */
async function host(): Promise<{ ctx: Context; origin: string; subject: Context }> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService, {})
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  const remotes = await ctx.plugin({ inject: ['typertGateway'], apply: applyApiRemotes })
  // The forwarded-event listeners live on the remotes fiber, so the waterfall has
  // to run in that scope for the real allowlist entry to see it.
  return { ctx, origin: `http://127.0.0.1:${String(ctx.webServer.port)}`, subject: remotes.ctx }
}

/** One forwarded waterfall as it arrives on the wire, before any projection. */
interface ProbeWaterfallFrame {
  readonly type: 'waterfall'
  readonly event: string
  readonly eventId: string
  readonly agentId: string
  readonly request: Readonly<Record<string, unknown>>
}

/** One connected Client that has opened the forwarded-event stream. */
interface ProbeClient {
  readonly socket: WebSocket
  readonly clientId: string
  readonly frames: ProbeWaterfallFrame[]
  readonly cancellations: string[]
  readonly closed: Promise<void>
}

/**
 * Connect one Client and open `$events`.
 * @param ctx - Host context supplying the cookie.
 * @param origin - Host origin.
 * @returns the connected Client once its opening frame arrived.
 */
async function connect(ctx: Context, origin: string): Promise<ProbeClient> {
  void origin
  const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
    headers: { cookie: browserCookie(ctx) },
  })
  const frames: ProbeWaterfallFrame[] = []
  const cancellations: string[] = []
  const ready = Promise.withResolvers<string>()
  socket.on('message', (data: { toString(): string }) => {
    const frame = JSON.parse(data.toString()) as { type?: string; streamId?: string; value?: unknown }
    if (frame.type !== 'item' || frame.streamId !== 'events') return
    const value = frame.value as { type?: string; clientId?: string; eventId?: string; event?: string; agentId?: string }
    if (value.type === 'ready' && typeof value.clientId === 'string') ready.resolve(value.clientId)
    if (value.type === 'waterfall' && value.event === 'approval/request'
      && typeof value.eventId === 'string' && typeof value.agentId === 'string') frames.push(value as ProbeWaterfallFrame)
    if (value.type === 'cancel' && typeof value.eventId === 'string') cancellations.push(value.eventId)
  })
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }))
  const closed = once(socket, 'close').then(() => undefined)
  const clientId = await ready.promise
  return { socket, clientId, frames, cancellations, closed }
}

/**
 * Reply to one pending waterfall as the Client it was delivered to.
 * @param ctx - Host context.
 * @param origin - Host origin.
 * @param client - the Client that received the frame.
 * @param eventId - pending waterfall identity.
 * @param outcome - Client decision.
 * @returns whether the Host accepted the reply.
 */
async function reply(
  ctx: Context,
  origin: string,
  client: ProbeClient,
  eventId: string,
  outcome: { kind: 'result'; value?: unknown } | { kind: 'next' },
): Promise<{ ok: boolean; message?: string }> {
  const response = await fetch(`${origin}/api/$events/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: browserCookie(ctx) },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `result-${eventId}`,
      method: '$events/result',
      payload: { args: { clientId: client.clientId, eventId, outcome } },
    }),
  })
  const body = await response.json() as { result?: { ok?: boolean; error?: { message?: string } } }
  if (body.result?.ok === true) return { ok: true }
  return { ok: false, ...body.result?.error?.message === undefined ? {} : { message: body.result.error.message } }
}

/**
 * Ask once, exactly as the approval service does.
 * @param ctx - Host context, used as the scoped Agent carrier.
 * @returns the outcome the waterfall settled on.
 */
async function ask(subject: Context, signal?: AbortSignal): Promise<unknown> {
  // The forwarded-event listener reads the Agent off the waterfall's scope carrier,
  // so the request runs exactly as user-approval runs it: scopeTarget(agent, agent).
  // The Agent double carries the two members that path reads (id and ctx), the same
  // way `user-approval/tests/approval.spec.ts:26-40` stands one in.
  const agent = { id: 'agent-fixture', ctx: subject } as unknown as Agent
  const target = scopeTarget(agent, agent)
  return await subject.waterfall(target, 'approval/request', {
    agent,
    toolName: 'bash',
    reason: 'run a command',
    ...signal === undefined ? {} : { signal },
  }, () => Promise.resolve<ApprovalOutcome>('unavailable'))
}

it('keeps approval/request as a forwarded waterfall', () => {
  const entry = API_REMOTE_FORWARDED_EVENTS.find(candidate => candidate.event === 'approval/request')
  expect(entry).toEqual({ event: 'approval/request', mode: 'waterfall' })
})

it('delivers the pending approval to a connected owner and accepts an explicit approval', async () => {
  const { ctx, origin, subject } = await host()
  const client = await connect(ctx, origin)
  const outcome = ask(subject)
  await vi.waitFor(() => { expect(client.frames).toHaveLength(1) })
  const frame = client.frames[0]!
  expect(frame.request).toMatchObject({ toolName: 'bash' })
  const accepted = await reply(ctx, origin, client, frame.eventId, { kind: 'result', value: 'allowed-once' })
  expect(accepted.ok).toBe(true)
  await expect(outcome).resolves.toBe('allowed-once')
  client.socket.close()
  await client.closed
})

it('accepts an explicit rejection without turning it into an approval', async () => {
  const { ctx, origin, subject } = await host()
  const client = await connect(ctx, origin)
  const outcome = ask(subject)
  await vi.waitFor(() => { expect(client.frames).toHaveLength(1) })
  const accepted = await reply(ctx, origin, client, client.frames[0]!.eventId, { kind: 'result', value: 'rejected' })
  expect(accepted.ok).toBe(true)
  await expect(outcome).resolves.toBe('rejected')
  client.socket.close()
  await client.closed
})

it('cancels the slower client when another one answered first', async () => {
  const { ctx, origin, subject } = await host()
  const first = await connect(ctx, origin)
  const second = await connect(ctx, origin)
  const outcome = ask(subject)
  await vi.waitFor(() => {
    expect(first.frames).toHaveLength(1)
    expect(second.frames).toHaveLength(1)
  })
  const eventId = first.frames[0]!.eventId
  expect(second.frames[0]!.eventId).toBe(eventId)
  expect((await reply(ctx, origin, first, eventId, { kind: 'result', value: 'allowed-once' })).ok).toBe(true)
  await expect(outcome).resolves.toBe('allowed-once')
  await vi.waitFor(() => { expect(second.cancellations).toEqual([eventId]) })
  // A reply after settlement is a documented no-op: the Host answers OK because the
  // request was well formed, and the settled outcome does not move.
  const late = await reply(ctx, origin, second, eventId, { kind: 'result', value: 'rejected' })
  expect(late.ok).toBe(true)
  await expect(outcome).resolves.toBe('allowed-once')
  first.socket.close()
  second.socket.close()
  await Promise.all([first.closed, second.closed])
})

it('leaves the approval pending when the only client disconnects, and settles it when the caller aborts', async () => {
  const { ctx, origin, subject } = await host()
  const client = await connect(ctx, origin)
  const controller = new AbortController()
  let settled = false
  const outcome = ask(subject, controller.signal).finally(() => { settled = true })
  await vi.waitFor(() => { expect(client.frames).toHaveLength(1) })
  client.socket.close()
  await client.closed
  await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
  // A vanished Client is not an answer: the pending waterfall stays pending until
  // the caller's own signal ends the turn that asked.
  expect(settled).toBe(false)
  controller.abort(new Error('turn cancelled'))
  await expect(outcome).rejects.toThrow()
  expect(settled).toBe(true)
  void origin
})
