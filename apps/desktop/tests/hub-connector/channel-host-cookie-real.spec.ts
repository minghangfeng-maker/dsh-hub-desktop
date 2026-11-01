/**
 * The real Host cookie, minted more than once against one Host.
 *
 * The exchange is not a boolean success signal — a minted credential comes back as
 * `303` plus `Set-Cookie` and a `false` return — so these cases run against the real
 * Connection rather than a double: first mint, reuse, invalidation, concurrent
 * readers, and two phone channels opened with the result.
 */

import { Context } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import WebSocket from 'ws'
import { afterEach, expect, it } from 'vitest'
import { provideBrowserCredentials } from '../../../../packages/api/gateway/tests/browser-credentials.ts'
import { createHostCookie } from '../../hub/plugins/hub-connector/src/channel/host-cookie.ts'

const roots: Context[] = []

afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
})

/**
 * Compose one Host with a real mux.
 * @returns the context, its origin, and a cookie source bound to it.
 */
async function host(): Promise<{ ctx: Context; origin: string; cookie: ReturnType<typeof createHostCookie> }> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService, {})
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const cookie = createHostCookie({
    origin: () => origin,
    authenticatedUrl: value => ctx.connection.authenticatedUrl(value),
    authorizeIndex: (request, response) => ctx.connection.authorizeIndex(request, response),
  })
  return { ctx, origin, cookie }
}

/**
 * Try one mux upgrade with a cookie.
 * @param ctx - Host context.
 * @param cookie - credential header value.
 * @returns whether the upgrade opened.
 */
async function opens(ctx: Context, cookie: string): Promise<boolean> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, { headers: { cookie } })
  const opened = await new Promise<boolean>((resolve) => {
    socket.once('open', () => { resolve(true) })
    socket.once('error', () => { resolve(false) })
    socket.once('unexpected-response', () => { resolve(false) })
  })
  socket.close()
  return opened
}

it('mints against one real Host, reuses it, and keeps working after invalidation', async () => {
  const { ctx, cookie } = await host()
  const first = await cookie.read()
  expect(first).toMatch(/=./u)
  // The same credential is reused without a second exchange.
  await expect(cookie.read()).resolves.toBe(first)
  await expect(opens(ctx, first)).resolves.toBe(true)

  cookie.invalidate()
  const second = await cookie.read()
  expect(second).toMatch(/=./u)
  // A fresh mint is a fresh credential; the old one stays valid (it is signed, not stored).
  await expect(opens(ctx, second)).resolves.toBe(true)
  await expect(opens(ctx, first)).resolves.toBe(true)
})

it('shares one exchange between concurrent readers on a real Host', async () => {
  const { ctx, cookie } = await host()
  const values = await Promise.all([cookie.read(), cookie.read(), cookie.read()])
  expect(new Set(values).size).toBe(1)
  await expect(opens(ctx, values[0])).resolves.toBe(true)
})

it('opens repeated phone channels with the same credential', async () => {
  const { ctx, cookie } = await host()
  const value = await cookie.read()
  await expect(opens(ctx, value)).resolves.toBe(true)
  await expect(opens(ctx, value)).resolves.toBe(true)
  await expect(opens(ctx, value)).resolves.toBe(true)
})

it('refuses a guessed cookie instead of assuming loopback is exempt', async () => {
  const { ctx } = await host()
  await expect(opens(ctx, 'dsh-auth-fixture=forged')).resolves.toBe(false)
})
