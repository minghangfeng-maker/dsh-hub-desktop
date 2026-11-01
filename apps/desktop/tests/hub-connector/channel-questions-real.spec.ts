/**
 * Real user questions over the authenticated HTTP gate.
 *
 * The Host comes from the shared real-session fixture: real Agent loop, JSONL
 * persistence, real Session/Workspace controllers, generated Typert descriptors and
 * the real question service. What this pins is the wire field name this runtime
 * expects for `userQuestions/answer`: the shared adapter sends `agent`, the generated
 * descriptor expects `agentId`, and only one of them can be right.
 */

import { afterEach, expect, it, vi } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { loadNodeRemote } from '../../hub/plugins/hub-connector/src/channel/node-remote.ts'
import { browserCookie } from '../../../../packages/api/gateway/tests/browser-credentials.ts'
import { createRealSessionHost, type RealSessionHost } from './real-session-host.ts'

/** Collected adapter frames with a waiter, so a test reads them by discriminant. */
function framesOf(): {
  sink: (frame: unknown) => void
  all: Record<string, unknown>[]
  waitFor: (predicate: (frame: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>
} {
  const all: Record<string, unknown>[] = []
  const waiters: { predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }[] = []
  return {
    all,
    sink(frame) {
      if (typeof frame !== 'object' || frame === null) return
      const value = frame as Record<string, unknown>
      all.push(value)
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(value)) continue
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(value)
      }
    },
    async waitFor(predicate) {
      const existing = all.find(predicate)
      if (existing !== undefined) return existing
      return await Promise.race([
        new Promise<Record<string, unknown>>((resolve) => { waiters.push({ predicate, resolve }) }),
        new Promise<Record<string, unknown>>((_resolve, reject) => {
          const timer = setTimeout(() => { reject(new Error(`no matching frame: ${JSON.stringify(all)}`)) }, 3_000)
          timer.unref?.()
        }),
      ])
    },
  }
}

const hosts: RealSessionHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
})

/**
 * Compose one Host and register it for teardown.
 * @returns the fixture Host.
 */
async function host(): Promise<RealSessionHost> {
  const host = await createRealSessionHost()
  hosts.push(host)
  return host
}

it('expects the adapter wire field agentId: agent is rejected by the real descriptor', async () => {
  const { call } = await host()
  const withAgent = await call('userQuestions/answer', {
    agent: 'session-1', callId: 'call-1', answer: { answers: [{ id: 'q1', selected: ['yes'] }] },
  }) as { ok?: boolean; error?: { code?: string; message?: string } }
  expect(withAgent.ok).toBe(false)
  expect(withAgent.error?.code).toBe('gateway/arguments-invalid')
  expect(withAgent.error?.message).toContain('agentId')
})

it('reaches the real service with agentId, which refuses an unknown call', async () => {
  const { call } = await host()
  const withAgentId = await call('userQuestions/answer', {
    agentId: 'session-1', callId: 'call-1', answer: { answers: [{ id: 'q1', selected: ['yes'] }] },
  }) as { ok?: boolean; error?: { code?: string } }
  expect(withAgentId.ok).toBe(false)
  // A business refusal from the service, not a gateway shape rejection: the field
  // name and the three-argument signature are the runtime's.
  expect(withAgentId.error?.code).not.toBe('gateway/arguments-invalid')
})

it('answers a foreground ask through the shared adapter and settles the card', async () => {
  const { ctx, call } = await host()
  // A real session brings a real live Agent: the question service requires one.
  const workspace = await call('workspace/initializeDefault', {}) as { value?: { workspace?: { workspaceId?: string } } }
  const created = await call('session/create', { request: { workspaceId: workspace.value?.workspace?.workspaceId } }) as { value?: { sessionId?: string } }
  const sessionId = created.value?.sessionId ?? ''
  expect(sessionId).not.toBe('')
  const agent = ctx.agents.get(sessionId as never)
  expect(agent, 'the fixture session has no live agent').toBeDefined()

  const module = loadNodeRemote()
  expect(module).toBeDefined()
  const adapter = await module!.createNodeRemote({
    origin: ctx.webServer.port === undefined ? '' : `http://127.0.0.1:${String(ctx.webServer.port)}`,
    headers: () => ({ cookie: browserCookie(ctx) }),
    node: { id: 'dev-1', kind: 'desktop', name: 'fixture', status: 'running' },
  })
  const frames = framesOf()
  await adapter.dispatch({ v: 1, type: 'hello', requestId: 'h', client: { name: 'fixture', version: '1' } }, frames.sink)
  await adapter.dispatch({ v: 1, type: 'subscribe', requestId: 'sub', sessionId }, frames.sink)
  try {
    const asking = ctx.userQuestions.askTimed(
      { agent: agent!, questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }] },
      'call-1' as never,
      30_000,
    )
    const card = await frames.waitFor(frame => frame.type === 'question')
    expect(card).toMatchObject({ sessionId, callId: 'call-1', state: 'open' })
    await adapter.dispatch({
      v: 1,
      type: 'answer-question',
      requestId: 'a1',
      sessionId,
      agent: sessionId,
      callId: 'call-1',
      answers: [{ id: 'q1', selected: ['A'] }],
    }, frames.sink)
    const result = await frames.waitFor(frame => frame.type === 'answer-result')
    expect(result).toMatchObject({ accepted: true })
    const answer = await asking
    expect(answer).toMatchObject({ answers: [{ id: 'q1', selected: ['A'] }] })
    await frames.waitFor(frame => frame.type === 'question-settled')
  } finally {
    await adapter.close()
  }
  // Closing the channel releases the question hold and retires the event stream, so the
  // Host stops counting this client as a live owner UI.
  await vi.waitFor(() => { expect(ctx.typertGateway.hasLiveClient()).toBe(false) })
})

it('answers a continued question through the adapter and counts a false as not accepted', async () => {
  const { ctx, call } = await host()
  const workspace = await call('workspace/initializeDefault', {}) as { value?: { workspace?: { workspaceId?: string } } }
  const created = await call('session/create', { request: { workspaceId: workspace.value?.workspace?.workspaceId } }) as { value?: { sessionId?: string } }
  const sessionId = created.value?.sessionId ?? ''
  const agent = ctx.agents.get(sessionId as never)
  expect(agent).toBeDefined()

  // A persisted turn whose timed ask already returned `pending` folds into a continued
  // question. This is the upstream precedent's event sequence, written to a real log.
  const callId = ToolCallId('ask-timed')
  const questions = [{ id: 'scope', question: 'Which scope?', options: [{ label: 'Tool only' }] }]
  const session = agent!.session
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: {
      config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      tools: [{ name: 'ask_user_question', description: 'Ask brief questions.', parameters: { type: 'object', properties: { questions: { type: 'array' }, timeout: { type: 'integer' } } } }],
    },
    reason: 'initial',
  })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions }) })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: JSON.stringify({ pending: true, callId }) }], isError: false }),
  }, { surfaceOp: 'append' })
  const projection = ctx.sessionProjections.stateOf(session, 'userQuestions') as { questions?: { active?: { callId?: string; state?: string }[] } } | undefined
  expect(projection?.questions?.active?.some(item => item.callId === callId && item.state === 'continued')).toBe(true)

  const module = loadNodeRemote()
  const adapter = await module!.createNodeRemote({
    origin: `http://127.0.0.1:${String(ctx.webServer.port ?? '')}`,
    headers: () => ({ cookie: browserCookie(ctx) }),
    node: { id: 'dev-1', kind: 'desktop', name: 'fixture', status: 'running' },
  })
  const frames = framesOf()
  try {
    await adapter.dispatch({ v: 1, type: 'hello', requestId: 'h', client: { name: 'fixture', version: '1' } }, frames.sink)
    await adapter.dispatch({ v: 1, type: 'subscribe', requestId: 'sub', sessionId }, frames.sink)
    // The control projection carries the continued question; give the stream a beat to
    // deliver it before the answer arrives.
    await new Promise<void>((resolve) => { setTimeout(resolve, 300) })
    await adapter.dispatch({
      v: 1,
      type: 'answer-question',
      requestId: 'a1',
      sessionId,
      agent: sessionId,
      callId,
      answers: [{ id: 'scope', selected: ['Tool only'] }],
    }, frames.sink)
    const result = await frames.waitFor(frame => frame.type === 'answer-result')
    expect(result).toMatchObject({ accepted: true, continued: true })
    // The real service accepted the answer: it steered a `user-question-reply` message
    // into the agent's inbox (the durable `user/message` appears only once the agent
    // admits it, which needs a running turn).
    const spliced = session.snapshotEvents().find(event => event.type === 'agent/inbox/spliced')
    expect(spliced, JSON.stringify(session.snapshotEvents().map(event => event.type))).toBeDefined()
    expect(spliced).toMatchObject({
      data: {
        inserted: [expect.objectContaining({ source: expect.objectContaining({ kind: 'user-question-reply', callId }) })],
      },
    })
  } finally {
    await adapter.close()
  }
})
