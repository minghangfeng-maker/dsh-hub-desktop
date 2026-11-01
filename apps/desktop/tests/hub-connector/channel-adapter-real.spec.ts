/**
 * The shared adapter package against a real Host: probe, gating, and read-only cost.
 *
 * Everything here is real — the Web server, the Connection cookie fence, the Typert
 * gateway, the forwarded-event allowlist, the WebSocket mux — and the package is the
 * shipped tarball. The Host's business endpoints are stubs that only answer "this
 * endpoint exists", because the question is the transport and approval chain, not
 * session semantics (the shared package has its own tests for those).
 *
 * Covered:
 * 1. `probeNodeRemote` reports capabilities without opening `$events`
 *    (`hasLiveClient()` stays false — the desktop must not look like an open UI);
 * 2. the adapter opens `$events` only after the phone said `hello`;
 * 3. an `approval/request` waterfall reaches the phone and an explicit approve
 *    settles it on the Host side, while a session the phone never subscribed to is
 *    answered with `next` instead of being shown.
 */

import { Context } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { apply as applyApiRemotes } from '@deepseek-ai/dsh-api-remotes'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { provideBrowserCredentials } from '../../../../packages/api/gateway/tests/browser-credentials.ts'
import { createHostCookie } from '../../hub/plugins/hub-connector/src/channel/host-cookie.ts'
import { createSharedAdapter, loadNodeRemote, probeCapabilities } from '../../hub/plugins/hub-connector/src/channel/node-remote.ts'
import { loadGeneratedDescriptors } from './typert-descriptors.ts'

const roots: Context[] = []

afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
})

/** One exact-approval waterfall the fixture raises. */
interface ApprovalRequest {
  readonly agent: Agent
  readonly toolName: string
  readonly reason?: string
  readonly callId?: string
}

/** Session endpoints the package probes; each records that the gateway reached it. */
class FixtureSession extends TypertRemoteService {
  readonly approvals: ApprovalRequest[] = []
  readonly outcomes: string[] = []
  /** Endpoint → how many calls the gateway actually dispatched. */
  readonly calls = new Map<string, number>()
  /** Sessions a phone subscribed to; the stream yields one opening snapshot each. */
  readonly snapshots = new Map<string, unknown>()

  constructor(ctx: Context) {
    // The generated descriptors name this Service `sessionController` in namespace `session`.
    super(ctx, 'sessionController', { namespace: 'session' })
  }

  /** Record one dispatch, proving the probe really reached this endpoint. */
  private hit(endpoint: string): void {
    this.calls.set(endpoint, (this.calls.get(endpoint) ?? 0) + 1)
  }

  // Signatures follow the generated descriptors: `session/list` takes `_request`,
  // every other session endpoint takes `request`.
  @Remote('list')
  list(_request?: unknown): unknown {
    this.hit('list')
    return { items: [] }
  }

  @Remote('page')
  page(request?: unknown): unknown {
    this.hit('page')
    void request
    return { records: [], hasMore: false }
  }

  @Remote('prompt')
  prompt(request?: unknown): unknown {
    this.hit('prompt')
    void request
    return { accepted: true }
  }

  @Remote('cancel')
  cancel(request?: unknown): unknown {
    this.hit('cancel')
    void request
    return { accepted: true }
  }

  @Remote('create')
  create(request?: unknown): unknown {
    this.hit('create')
    void request
    return { sessionId: 'fixture-session' }
  }

  /**
   * The probe opens this with an invalid payload and expects a rejection: a healthy
   * Host answers an error frame rather than streaming, which is what marks the
   * endpoint present. A real subscription then opens again with a valid address.
   */
  @Remote({ name: 'follow', mode: 'stream' })
  async *follow(request?: { readonly address?: unknown }): AsyncIterable<unknown> {
    this.hit('follow')
    if (request?.address === undefined) {
      // The probe opens with an unaddressable payload on purpose; a real Host answers
      // an error frame there, which is what marks the endpoint present.
      throw new Error('session/follow needs a session address')
    }
    yield { type: 'snapshot', cursor: 0, records: [], hasMore: false, projections: {} }
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
  }
}

/** Question endpoint the package probes. */
/**
 * Question endpoint stub with the real three-parameter signature. Answering is NOT
 * verified here: a positive answer needs the real UserQuestions service and a live
 * Agent, so this fixture only proves the endpoint is dispatched and that the adapter
 * refuses before calling it for a call the phone does not own.
 */
class FixtureQuestions extends TypertRemoteService {
  readonly calls: { agent: unknown; callId: unknown; answer: unknown }[] = []

  constructor(ctx: Context) {
    super(ctx, 'userQuestions', { namespace: 'userQuestions' })
  }

  @Remote('answer')
  answer(agent: unknown, callId: unknown, answer: unknown): boolean {
    this.calls.push({ agent, callId, answer })
    return true
  }
}

/** Workspace endpoint the package probes for `create`. */
class FixtureWorkspace extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'workspaceController', { namespace: 'workspace' })
  }

  @Remote('initializeDefault')
  initializeDefault(): unknown {
    return { workspace: { workspaceId: 'fixture' } }
  }
}

/** Endpoints the shared adapter probes and drives in these fixtures. */
const FIXTURE_ENDPOINTS = [
  'session/list',
  'session/page',
  'session/prompt',
  'session/cancel',
  'session/create',
  'session/follow',
  'userQuestions/answer',
  'workspace/initializeDefault',
] as const

/**
 * Compose the Host fixture.
 * @returns the context, Host origin, and the session fixture.
 */
async function host(): Promise<{ ctx: Context; origin: string; session: FixtureSession }> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService, {})
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  await ctx.plugin({ inject: ['typertGateway'], apply: applyApiRemotes })
  await ctx.plugin(FixtureSession)
  await ctx.plugin(FixtureQuestions)
  await ctx.plugin(FixtureWorkspace)
  // The composition registers the generator's own descriptors, so endpoint
  // validation and dispatch use the real signatures rather than a fixture guess.
  ctx.typert.register({
    package: '@fixture/mobile',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: await loadGeneratedDescriptors(FIXTURE_ENDPOINTS),
  })
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const session = ctx.get('sessionController') as unknown as FixtureSession
  return { ctx, origin, session }
}

/**
 * Async frame collector for one adapter.
 * @returns the sink and a waiter for the next frame matching a predicate.
 */
function frames(): {
  sink: (frame: unknown) => void
  all: unknown[]
  waitFor: (predicate: (frame: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>
} {
  const all: unknown[] = []
  const waiters: { predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }[] = []
  const sink = (frame: unknown): void => {
    all.push(frame)
    if (typeof frame !== 'object' || frame === null) return
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame as Record<string, unknown>)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(frame as Record<string, unknown>)
      }
    }
  }
  return {
    sink,
    all,
    async waitFor(predicate) {
      const existing = all.find((frame): boolean => typeof frame === 'object' && frame !== null && predicate(frame as Record<string, unknown>))
      if (existing !== undefined) return existing as Record<string, unknown>
      return await new Promise((resolve) => { waiters.push({ predicate, resolve }) })
    },
  }
}

/** Build an Agent-shaped fixture for the approval waterfall. */
function agentOf(ctx: Context, id: string): Agent {
  return { id, ctx } as unknown as Agent
}

it('serves every probed endpoint to the adapter credential, and the probe opens no event stream', async () => {
  const { ctx, origin, session } = await host()
  const module = loadNodeRemote()
  expect(module).toBeDefined()
  const cookie = createHostCookie({
    origin: () => origin,
    authenticatedUrl: value => ctx.connection.authenticatedUrl(value),
    authorizeIndex: (request, response) => ctx.connection.authorizeIndex(request, response),
  })

  // The probe's flags alone are advisory: a transport error is not a "missing
  // endpoint" code, so anything that fails before dispatch still counts as present.
  // These unary calls use the same frozen envelope and credential the adapter uses,
  // and the fixture counts each dispatch, so the capability is real rather than
  // fail-open.
  const envelope = async (endpoint: string, args: Record<string, unknown>): Promise<boolean> => {
    const response = await fetch(`${origin}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookie.read() },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `probe-${endpoint}`,
        method: endpoint,
        payload: { args },
      }),
    })
    const body = await response.json() as { result?: { ok?: boolean } }
    return response.ok && body.result?.ok === true
  }
  // Real descriptors mean real payload shapes: these are the arguments the mobile
  // adapter itself sends, so a schema drift fails here instead of on a phone.
  const address = { address: { kind: 'session', sessionId: 'fixture-session' } }
  const payloads: [string, Record<string, unknown>][] = [
    ['session/list', { _request: {} }],
    // `throughSeq` is required by the real schema and comes from the follow opening.
    ['session/page', { request: { ...address, throughSeq: 0 } }],
    ['session/prompt', { request: { requestId: 'r1', sessionId: 'fixture-session', mode: 'queue', content: [{ type: 'text', text: 'hi' }] } }],
    ['session/cancel', { request: { sessionId: 'fixture-session' } }],
    ['session/create', { request: {} }],
    ['workspace/initializeDefault', {}],
    // `userQuestions/answer` is deliberately absent: the generated descriptor for this
    // checkout uses wire field `agentId`, while the shared adapter sends `agent` (the
    // name the pinned 0.2.1-rc.2 runtime uses). That version skew is reported for the
    // contract owner to settle; this fixture does not paper over it with a guess.
  ]
  for (const [endpoint, args] of payloads) {
    await expect(envelope(endpoint, args), endpoint).resolves.toBe(true)
  }
  for (const method of ['list', 'page', 'prompt', 'cancel', 'create']) {
    expect(session.calls.get(method) ?? 0, method).toBeGreaterThan(0)
  }

  const probe = await probeCapabilities(module!, { origin, cookie, node: { id: 'dev-1', name: 'fixture', status: 'running' } })
  expect(probe).not.toBeNull()
  expect(probe!.capabilities).toMatchObject({ sessions: true, history: true, send: true, stop: true, create: true })
  // The read-only probe must not make the Host believe an owner Client is live.
  expect(ctx.typertGateway.hasLiveClient()).toBe(false)
})

it('opens the event stream only after the phone says hello, then relays an approval', async () => {
  const { ctx, origin, session } = await host()
  const module = loadNodeRemote()
  const cookie = createHostCookie({
    origin: () => origin,
    authenticatedUrl: value => ctx.connection.authenticatedUrl(value),
    authorizeIndex: (request, response) => ctx.connection.authorizeIndex(request, response),
  })
  const adapter = await createSharedAdapter(module!, {
    origin, cookie, nodeName: 'fixture', hostStatus: () => 'running',
    channel: { channelId: 'ch-1', nodeId: 'dev-1' },
  })
  const framesSeen = frames()
  expect(ctx.typertGateway.hasLiveClient()).toBe(false)

  await adapter.dispatch({ v: 1, type: 'hello', client: { name: 'test', version: '1' } }, framesSeen.sink)
  const hello = await framesSeen.waitFor(frame => frame['type'] === 'hello')
  expect(hello).toMatchObject({ v: 1, type: 'hello' })
  // The phone's hello is what opens `$events`; the probe above did not.
  await new Promise<void>((resolve) => { setTimeout(resolve, 150) })
  expect(ctx.typertGateway.hasLiveClient()).toBe(true)

  // Only a subscribed session may be shown on the phone.
  const other = agentOf(ctx, 'not-subscribed')
  const ignored = await ctx.waterfall(scopeTarget(other, other), 'approval/request', { agent: other, toolName: 'bash' }, () => Promise.resolve<ApprovalOutcome>('unavailable'))
  expect(ignored).toBe('unavailable')

  // A subscribed session reaches the phone as an approval card.
  const subscribed = agentOf(ctx, 'fixture-session')
  session.snapshots.set('fixture-session', { type: 'snapshot' })
  await adapter.dispatch({ v: 1, type: 'subscribe', requestId: 'r1', sessionId: 'fixture-session' }, framesSeen.sink)
  session.approvals.push({ agent: subscribed, toolName: 'bash', reason: 'needs a shell' })
  const pending = ctx.waterfall(scopeTarget(subscribed, subscribed), 'approval/request', { agent: subscribed, toolName: 'bash', reason: 'needs a shell' }, () => Promise.resolve<ApprovalOutcome>('unavailable'))
  const card = await framesSeen.waitFor(frame => frame['type'] === 'approval')
  const approval = card['approval'] as { approvalId: string; tool: string; answerable: boolean }
  expect(approval).toMatchObject({ tool: 'bash', answerable: true })
  await adapter.dispatch({
    v: 1,
    type: 'answer-approval',
    requestId: 'r2',
    sessionId: 'fixture-session',
    approvalId: approval.approvalId,
    decision: 'approve',
  }, framesSeen.sink)
  await expect(pending).resolves.toBe('allowed-once')
  await framesSeen.waitFor(frame => frame['type'] === 'approval-settled' && frame['decision'] === 'approve')
  await adapter.close()
  // Cancelling the stream reaches the Host asynchronously.
  await vi.waitFor(() => { expect(ctx.typertGateway.hasLiveClient()).toBe(false) })
})

it('refuses a question the phone has no open call for, without calling the Host', async () => {
  const { ctx, origin, session } = await host()
  const module = loadNodeRemote()
  const cookie = createHostCookie({
    origin: () => origin,
    authenticatedUrl: value => ctx.connection.authenticatedUrl(value),
    authorizeIndex: (request, response) => ctx.connection.authorizeIndex(request, response),
  })
  const adapter = await createSharedAdapter(module!, {
    origin, cookie, nodeName: 'fixture', hostStatus: () => 'running',
    channel: { channelId: 'ch-1', nodeId: 'dev-1' },
  })
  const framesSeen = frames()
  await adapter.dispatch({ v: 1, type: 'hello', client: { name: 'test', version: '1' } }, framesSeen.sink)
  await framesSeen.waitFor(frame => frame['type'] === 'hello')
  // An answer for a session this phone never subscribed is refused before any Host call.
  await adapter.dispatch({
    v: 1, type: 'answer-question', requestId: 'q1', sessionId: 'fixture-session',
    agent: 'fixture-session', callId: 'unknown-call',
    answers: [{ id: 'a', selected: ['yes'] }],
  }, framesSeen.sink).catch(() => undefined)
  const refused = await framesSeen.waitFor(frame => frame['type'] === 'error' && frame['requestId'] === 'q1')
  expect(refused).toMatchObject({ code: 'question-not-answerable' })
  await adapter.close()
  void session
})

it('leaves a pending approval unapproved when the adapter closes', async () => {
  const { ctx, origin, session } = await host()
  const module = loadNodeRemote()
  const cookie = createHostCookie({
    origin: () => origin,
    authenticatedUrl: value => ctx.connection.authenticatedUrl(value),
    authorizeIndex: (request, response) => ctx.connection.authorizeIndex(request, response),
  })
  const adapter = await createSharedAdapter(module!, {
    origin, cookie, nodeName: 'fixture', hostStatus: () => 'running',
    channel: { channelId: 'ch-1', nodeId: 'dev-1' },
  })
  const framesSeen = frames()
  await adapter.dispatch({ v: 1, type: 'hello', client: { name: 'test', version: '1' } }, framesSeen.sink)
  await framesSeen.waitFor(frame => frame['type'] === 'hello')
  await adapter.dispatch({ v: 1, type: 'subscribe', requestId: 'r1', sessionId: 'fixture-session' }, framesSeen.sink)
  const agent = agentOf(ctx, 'fixture-session')
  let settled = false
  const pending = ctx.waterfall(scopeTarget(agent, agent), 'approval/request', { agent, toolName: 'bash' }, () => Promise.resolve<ApprovalOutcome>('unavailable'))
    .finally(() => { settled = true })
  await framesSeen.waitFor(frame => frame['type'] === 'approval')
  await adapter.close()
  // Closing the channel is not an approval: the adapter answers each pending request
  // with `next`, so the Host falls through to the fail-closed tail. The outcome must
  // never be an approval.
  await expect(pending).resolves.toBe('unavailable')
  expect(settled).toBe(true)
  void session
})

it('answers a 120-second approval nobody touches with next, never an approval', async () => {
  const { ctx, origin, session } = await host()
  const module = loadNodeRemote()
  const cookie = createHostCookie({
    origin: () => origin,
    authenticatedUrl: value => ctx.connection.authenticatedUrl(value),
    authorizeIndex: (request, response) => ctx.connection.authorizeIndex(request, response),
  })
  const adapter = await createSharedAdapter(module!, {
    origin, cookie, nodeName: 'fixture', hostStatus: () => 'running',
    channel: { channelId: 'ch-1', nodeId: 'dev-1' },
  })
  const framesSeen = frames()
  await adapter.dispatch({ v: 1, type: 'hello', client: { name: 'test', version: '1' } }, framesSeen.sink)
  await framesSeen.waitFor(frame => frame['type'] === 'hello')
  await adapter.dispatch({ v: 1, type: 'subscribe', requestId: 'r1', sessionId: 'fixture-session' }, framesSeen.sink)
  await new Promise<void>((resolve) => { setTimeout(resolve, 200) })

  // Only `setTimeout` is faked: the adapter's 120s approval deadline is a timer, while
  // the real sockets keep running on `setInterval` and the event loop.
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  const agent = agentOf(ctx, 'fixture-session')
  const pending = ctx.waterfall(scopeTarget(agent, agent), 'approval/request', { agent, toolName: 'bash' }, () => Promise.resolve<ApprovalOutcome>('unavailable'))
  try {
    // The card arrives through the real socket; poll without fake timers.
    for (let index = 0; index < 200 && framesSeen.all.every(frame => (frame as Record<string, unknown>)['type'] !== 'approval'); index += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }
    expect(framesSeen.all.some(frame => (frame as Record<string, unknown>)['type'] === 'approval')).toBe(true)
    vi.advanceTimersByTime(120_000)
    await expect(pending).resolves.toBe('unavailable')
    for (let index = 0; index < 200 && !framesSeen.all.some(frame => (frame as Record<string, unknown>)['type'] === 'approval-settled'); index += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }
    expect(framesSeen.all.some((frame) => {
      const value = frame as Record<string, unknown>
      return value['type'] === 'approval-settled' && value['decision'] === 'expired'
    })).toBe(true)
  } finally {
    vi.useRealTimers()
    await adapter.close()
  }
  void session
})
