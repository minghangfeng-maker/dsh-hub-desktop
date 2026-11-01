/** Local integration evidence: real Session/Workspace owners behind authenticated HTTP. */
import { afterEach, expect, it, vi } from 'vitest'
import { loadNodeRemote } from '../../hub/plugins/hub-connector/src/channel/node-remote.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createRealSessionHost, type RealSessionHost } from './real-session-host.ts'

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

/** One adapter frame, read by discriminant rather than by a typed union. */
type Frame = Record<string, unknown>

/**
 * Find the first frame of one type.
 * @param frames - collected frames.
 * @param type - discriminant to match.
 * @returns the frame, or undefined.
 */
function frameOf(frames: readonly Frame[], type: string): Frame | undefined {
  return frames.find(frame => frame['type'] === type)
}

it('real HTTP list, initialize workspace, create, list and prompt with named arguments', async () => {
  const { ctx, call } = await host()
  expect(await call('session/list', { _request: {} })).toMatchObject({ ok: true, value: { items: [] } })
  const workspace = await call('workspace/initializeDefault', {}) as { ok?: boolean; value?: { workspace?: { workspaceId?: string } } }
  expect(workspace, JSON.stringify(workspace)).toMatchObject({ ok: true })
  const workspaceId = workspace.value?.workspace?.workspaceId
  expect(workspaceId).toBeTruthy()
  const created = await call('session/create', { request: { workspaceId } }) as { ok?: boolean; value?: { sessionId?: string } }
  expect(created, JSON.stringify(created)).toMatchObject({ ok: true })
  const sessionId = created.value?.sessionId
  expect(sessionId).toBeTruthy()
  expect(await call('session/list', { _request: {} })).toMatchObject({ ok: true, value: { items: [expect.objectContaining({ sessionId })] } })
  const request = { sessionId, requestId: 'same-message-id', mode: 'queue', content: [{ type: 'text', text: 'hello actual controller' }] }
  expect(await call('session/prompt', { request })).toMatchObject({ ok: true, value: { accepted: true } })
  expect(await call('session/prompt', { request })).toMatchObject({ ok: true, value: { accepted: true } })
  const events = ctx.sessions.get(SessionId(sessionId!))!.snapshotEvents()
  const matching = events.filter((event) => {
    if (event.type !== 'user/message') return false
    const source = event.data.source
    return source.kind === 'user' && 'rpcId' in source && source.rpcId === request.requestId
  })
  expect(matching, JSON.stringify(events.map(event => ({ type: event.type, data: event.data })))).toHaveLength(1)
})

it('shared adapter uses real controllers for probe, creation, text history and reconnect catch-up', async () => {
  const { ctx, origin, cookie } = await host()
  const headers = (): Record<string, string> => ({ cookie })
  const options = {
    origin,
    headers,
    node: { id: 'fixture', kind: 'desktop' as const, name: 'fixture', status: 'host-running' },
  }
  // The adapter package is resolved the way the connector resolves it in production:
  // through its own installed dependency, not a path this checkout happens to have.
  const module = loadNodeRemote()
  expect(module, 'the shared adapter package is not installed').toBeDefined()
  const probe = await module!.probeNodeRemote!(options)
  expect(probe, JSON.stringify(probe)).toMatchObject({ compatible: true })
  expect(ctx.typertGateway.hasLiveClient()).toBe(false)
  const remote = await module!.createNodeRemote(options)
  const frames: Frame[] = []
  const sink = (frame: unknown): void => { frames.push(frame as Frame) }
  try {
    await remote.dispatch({ v: 1, type: 'hello', requestId: 'hello', client: { name: 'fixture', version: '1' } }, sink)
    await remote.dispatch({ v: 1, type: 'create', requestId: 'create' }, sink)
    const created = frameOf(frames, 'created')
    expect(created, JSON.stringify(frames)).toBeDefined()
    const sessionId = String(created!['sessionId'])
    const session = ctx.sessions.get(SessionId(sessionId))!
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'first persisted text' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 'sub', sessionId }, sink)
    await vi.waitFor(() => { expect(frames.some(frame => frame['type'] === 'replay')).toBe(true) })
    await remote.dispatch({ v: 1, type: 'history', requestId: 'history', sessionId }, sink)
    const history = frameOf(frames, 'history')
    expect(history?.['items'], JSON.stringify(frames)).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'first persisted text' })]))
    await remote.dispatch({ v: 1, type: 'send', requestId: 'send', clientMessageId: 'actual-mobile-message', sessionId, text: 'sent through real adapter' }, sink)
    await vi.waitFor(() => {
      expect(frames.some(frame => frame['type'] === 'message'
        && frame['clientMessageId'] === 'actual-mobile-message'
        && frame['text'] === 'sent through real adapter'), JSON.stringify(frames)).toBe(true)
    })
    expect(frames.some(frame => frame['type'] === 'ack' && frame['clientMessageId'] === 'actual-mobile-message')).toBe(true)
    const cursor = frameOf(frames, 'replay')!['toCursor']
    await remote.close()
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'desktop while phone offline' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const reopened = await module!.createNodeRemote(options)
    try {
      const replayed: Frame[] = []
      await reopened.dispatch({ v: 1, type: 'subscribe', requestId: 'resub', sessionId, sinceCursor: cursor }, (frame) => { replayed.push(frame as Frame) })
      await vi.waitFor(() => {
        expect(replayed.some(frame => frame['type'] === 'message' && frame['text'] === 'desktop while phone offline'), JSON.stringify(replayed)).toBe(true)
      })
      expect(replayed.findIndex(frame => frame['type'] === 'replay'))
        .toBeGreaterThan(replayed.findIndex(frame => frame['type'] === 'message' && frame['text'] === 'desktop while phone offline'))
    } finally { await reopened.close() }
  } finally { await remote.close() }
})
