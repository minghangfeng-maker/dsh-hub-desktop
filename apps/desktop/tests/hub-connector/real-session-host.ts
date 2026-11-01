/**
 * One real Host for the mobile adapter specs: real Agent loop, JSONL persistence in
 * a temp directory, real Session and Workspace controllers, generated Typert
 * descriptors, the real question service, and the application's forwarded events.
 *
 * Every caller gets an authenticated HTTP `call` and the cookie the adapter needs,
 * so a spec never invents a session or a descriptor. Composing the Host here keeps
 * the business gate and the adapter specs on one definition of "real".
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { apply as connection, inject } from '@deepseek-ai/dsh-client-connection'
import { apply as remotes } from '@deepseek-ai/dsh-api-remotes'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createSessionTestController } from '../../../../packages/api/session-controller/tests/test-remote.ts'
import { MemoryStorageBackend } from '../../../../packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import { browserCookie, provideBrowserCredentials } from '../../../../packages/api/gateway/tests/browser-credentials.ts'
import { TYPERT as sessionTypes } from '../../../../packages/api/session-controller/lib/typert.host.js'
import { TYPERT as workspaceTypes } from '../../../../packages/api/workspace-controller/lib/typert.host.js'
import { TYPERT as questionTypes } from '../../../../packages/interaction/user-questions/lib/typert.host.js'

/**
 * Narrow a generated `TYPERT` export to the contribution the registry accepts.
 * @param value - generated descriptor set; the generator types it `unknown`.
 * @returns the same value, checked for the fields the registry reads.
 */
export function contribution(value: unknown): TypertContribution {
  if (typeof value !== 'object' || value === null) throw new Error('generated TYPERT is not an object')
  const record = value as Record<string, unknown>
  if (typeof record.package !== 'string' || record.face !== 'host'
    || !Array.isArray(record.schemas) || !Array.isArray(record.invocations)
    || typeof record.model !== 'object' || record.model === null) {
    throw new Error('generated TYPERT is not a host contribution')
  }
  return value as TypertContribution
}

/** One authenticated HTTP caller on the fixture Host. */
export type HostCall = (method: string, args: Record<string, unknown>) => Promise<unknown>

/** A composed fixture Host and everything a spec needs to drive it. */
export interface RealSessionHost {
  /** Host context; dispose it after the spec. */
  readonly ctx: Context
  /** Authenticated `POST /api/<method>` with the frozen unary envelope. */
  readonly call: HostCall
  /** Host origin. */
  readonly origin: string
  /** Browser cookie the adapter presents to the Host. */
  readonly cookie: string
  /** Dispose the Host and remove its temporary directory. */
  dispose(): Promise<void>
}

/**
 * Compose one real Host.
 * @returns the Host, its caller, and a disposer.
 */
export async function createRealSessionHost(): Promise<RealSessionHost> {
  const dir = await mkdtemp(join(tmpdir(), 'mobile-real-host-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    provideBrowserCredentials(ctx)
    await ctx.plugin(TypertRegistry)
    ctx.typert.register(contribution(sessionTypes))
    ctx.typert.register(contribution(workspaceTypes))
    ctx.typert.register(contribution(questionTypes))
    await ctx.plugin(RemoteAccess)
    await ctx.plugin(Gateway, {})
    await ctx.plugin({ inject: [...inject], apply: connection })
    await ctx.plugin({ inject: ['typertGateway'], apply: remotes })
    await ctx.plugin(UserQuestions)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend())
    const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', domain)
    ctx.provide('storageDomain', domain)
    await ctx.plugin(JsonlPersistence, { root: join(dir, 'sessions'), compression: 'none' })
    await ctx.plugin(WorkspaceRegistry)
    await ctx.plugin(WorkspaceController, { documentsDirectory: dir })
    await ctx.plugin({
      inject: ['agents', 'sessions', 'typert', 'remoteAccess', 'workspaceRegistry', 'fs', 'llm', 'sessionProjections', 'sessionPersistence'],
      apply(scope) {
        createSessionTestController(scope, {
          defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }),
          cwd: dir,
        })
      },
    })
  } catch (error) {
    await ctx.fiber.dispose().catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  const port = ctx.webServer.port
  if (port === undefined) throw new Error('real host: the Web server did not bind')
  const origin = `http://127.0.0.1:${String(port)}`
  const cookie = browserCookie(ctx)
  const call: HostCall = async (method, args) => {
    const response = await fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `test-${method}`, method, payload: { args } }),
    })
    const text = await response.text()
    if (response.status !== 200) throw new Error(`real host: ${method} answered ${String(response.status)}: ${text}`)
    return (JSON.parse(text) as { result?: unknown }).result
  }
  return {
    ctx,
    call,
    origin,
    cookie,
    async dispose() {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}
