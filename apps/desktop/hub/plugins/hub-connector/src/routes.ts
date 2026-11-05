/**
 * The account page's read/write routes.
 *
 * The Web client reaches these over the same authenticated origin it already
 * uses for RPC: every handler first passes Connection's browser authentication,
 * so a local process without the session cookie gets 401 and the handler never
 * runs. The payloads are the connector's own status document — user name, role,
 * points, device identity, and the exact body of the last device report — none of
 * which is a credential.
 *
 * Six routes exist, all under `/hub-connector/api/`:
 * `state` (GET), `settings` (POST), `refresh` (POST: re-read the Hub session),
 * `check` (POST: pull the manifest now), `restart` (POST: ask the desktop shell
 * for the pending restart, which only the shell can perform), and `channel`
 * (GET/POST: the local phone-access switch and its connection status).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ChannelController } from './channel/controller.ts'
import { HubOriginChangeError } from './connector.ts'
import type { HubConnector } from './connector.ts'
import { warn } from './log.ts'

/** Route prefix the client bundle fetches. */
export const ROUTE_PREFIX = '/hub-connector/api'

/** Largest settings body accepted; the document is three short fields. */
const MAX_BODY_BYTES = 64 * 1024

/** Write one JSON answer. */
function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/** Read one JSON request body, refusing anything oversized. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += bytes.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(bytes)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** Read one optional string member of a settings patch. */
function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

/**
 * Register the account-page routes.
 * @param ctx - Host context supplying the webserver and connection services.
 * @param connector - The connector the routes report on.
 * @param channel - Phone-access switch the `channel` route reads and writes; omitted only by
 * a composition that has no outbound channel.
 * @returns Disposer removing every route.
 */
export function registerClientRoutes(ctx: Context, connector: HubConnector, channel?: ChannelController): () => void {
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (webServer === undefined || connection === undefined) {
    warn('the Web client is absent, so the Hub account page has no routes')
    return () => undefined
  }
  const dispose: (() => void)[] = []
  const route = (path: string, handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): void => {
    dispose.push(webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/${path}`,
      handler: (request, response) => {
        if (!connection.authorizeIndex({
          headers: request.headers,
          ...request.method === undefined ? {} : { method: request.method },
          ...request.url === undefined ? {} : { url: request.url },
        }, response)) return
        void handler(request, response).catch((error: unknown) => {
          warn(`client route ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
          if (!response.headersSent) json(response, 500, { error: 'internal' })
        })
      },
    }))
  }
  route('state', async (_request, response) => {
    const status = await connector.status()
    // One poll feeds the whole account page: the connector document plus the
    // phone switch, which lives beside it rather than inside it.
    json(response, 200, channel === undefined ? status : { ...status, channel: channel.status() })
  })
  route('settings', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method' })
      return
    }
    try {
      const body = await readJson(request)
      const value = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
      // Every member is read before anything is written, so a request that carries a
      // bad address and a device name applies neither.
      const origin = optionalText(value.hubOrigin, 'hubOrigin')
      const deviceName = optionalText(value.deviceName, 'deviceName')
      const deepSeekLogin = typeof value.deepSeekLogin === 'boolean' ? value.deepSeekLogin : undefined
      if (origin !== undefined) await connector.changeHubOrigin(origin)
      connector.saveSettings({
        ...deviceName === undefined ? {} : { deviceName },
        ...deepSeekLogin === undefined ? {} : { deepSeekLogin },
      })
      json(response, 200, await connector.status())
    } catch (error) {
      if (error instanceof HubOriginChangeError) {
        if (error.code === 'sign-in-in-progress') {
          json(response, 409, { error: error.code })
          return
        }
        json(response, 400, { error: error.code, message: error.message })
        return
      }
      json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  route('login', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method' })
      return
    }
    // The browser opens the authorize page and the Hub redirects back to this same
    // origin, so the Host header names the only callback this route may use.
    const host = request.headers.host ?? ''
    if (host === '' || !/^(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/u.test(host)) {
      json(response, 400, { error: 'unusable-host' })
      return
    }
    await connector.startLogin(`http://${host}`)
    json(response, 200, await connector.status())
  })
  route('refresh', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method' })
      return
    }
    await connector.refreshSession()
    json(response, 200, await connector.status())
  })
  route('restart', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method' })
      return
    }
    if (!connector.requestRestart()) {
      json(response, 409, { error: 'no-restart' })
      return
    }
    json(response, 200, await connector.status())
  })
  route('check', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method' })
      return
    }
    await connector.pullManifest()
    json(response, 200, await connector.status())
  })
  route('channel', async (request, response) => {
    if (channel === undefined) {
      json(response, 404, { error: 'no-channel' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      json(response, 405, { error: 'method' })
      return
    }
    if (request.method === 'GET') {
      json(response, 200, channel.status())
      return
    }
    try {
      const body = await readJson(request)
      const value = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
      if (typeof value.enabled !== 'boolean') {
        json(response, 400, { error: 'enabled' })
        return
      }
      json(response, 200, channel.setEnabled(value.enabled))
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  return () => { for (const disposer of dispose) disposer() }
}
