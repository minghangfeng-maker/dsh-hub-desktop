/**
 * The Host credential the relay adapter connects with.
 *
 * A cookie minted in-process is the only legitimate way to reach `/api` and
 * `/api/remote.mux`; these cases pin the exchange, the reuse, the invalidation path
 * a 401 needs, and the refusal that must not fall back to "loopback is exempt".
 */

import { expect, it, vi } from 'vitest'
import { cookiePairOf, createHostCookie } from '../../hub/plugins/hub-connector/src/channel/host-cookie.ts'

/**
 * One authority double that answers like the real Host: a token exchange writes
 * `303` with `Set-Cookie` and returns **false**, `true` only means an existing
 * cookie already passed, and a refusal writes `401` without a cookie.
 */
function authority(options: { accept?: boolean; setCookie?: string; passthrough?: boolean; token?: string } = {}) {
  const record = {
    mints: 0,
    origin: () => 'http://127.0.0.1:53211',
    authenticatedUrl: (origin: string) => `${origin}/?token=${options.token ?? 'tok'}`,
    authorizeIndex: (
      _request: { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>> },
      response: {
        writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
        end(body?: string): unknown
      },
    ): boolean => {
      record.mints += 1
      if (options.accept === false) {
        response.writeHead(401, { 'cache-control': 'no-store' })
        return false
      }
      if (options.passthrough === true) {
        // The "already authenticated" branch: serve the index, mint nothing.
        response.writeHead(303, { location: './' })
        return true
      }
      response.writeHead(303, { location: './', 'set-cookie': options.setCookie ?? 'dsh-auth-fixture=abc123; Path=/; HttpOnly' })
      return false
    },
  }
  return record
}

it('reduces a Set-Cookie header to the request pair', () => {
  expect(cookiePairOf('dsh-auth=abc; Path=/; HttpOnly')).toBe('dsh-auth=abc')
  expect(cookiePairOf('  spaced=1  ')).toBe('spaced=1')
  expect(cookiePairOf('HttpOnly; Secure')).toBe('')
  expect(cookiePairOf('=nope')).toBe('')
})

it('mints the cookie on first use and reuses it afterwards', async () => {
  const source = authority()
  const cookie = createHostCookie(source)
  await expect(cookie.read()).resolves.toBe('dsh-auth-fixture=abc123')
  await expect(cookie.read()).resolves.toBe('dsh-auth-fixture=abc123')
  expect(source.mints).toBe(1)
})

it('mints a fresh cookie after invalidation, which is what a rejected credential needs', async () => {
  const source = authority()
  const cookie = createHostCookie(source)
  await cookie.read()
  cookie.invalidate()
  await cookie.read()
  expect(source.mints).toBe(2)
})

it('mints again after invalidation while a reader is in flight', async () => {
  const source = authority()
  const cookie = createHostCookie(source)
  const first = cookie.read()
  cookie.invalidate()
  const second = cookie.read()
  await expect(Promise.all([first, second])).resolves.toEqual(['dsh-auth-fixture=abc123', 'dsh-auth-fixture=abc123'])
  expect(source.mints).toBe(2)
})

it('mints from the response, not from the boolean: a 303 with Set-Cookie returns false', async () => {
  const source = authority()
  const cookie = createHostCookie(source)
  await expect(cookie.read()).resolves.toBe('dsh-auth-fixture=abc123')
  expect(source.mints).toBe(1)
})

it('refuses with the status when the Host mints nothing', async () => {
  const refused = createHostCookie(authority({ accept: false }))
  await expect(refused.read()).rejects.toThrow(/status 401/u)
  // `true` is the "existing cookie already passed" branch, which mints nothing for us.
  const passthrough = createHostCookie(authority({ passthrough: true }))
  await expect(passthrough.read()).rejects.toThrow(/minted no cookie/u)
})

it('shares one mint between concurrent readers', async () => {
  const source = authority()
  const cookie = createHostCookie(source)
  const [first, second, third] = await Promise.all([cookie.read(), cookie.read(), cookie.read()])
  expect([first, second, third]).toEqual(['dsh-auth-fixture=abc123', 'dsh-auth-fixture=abc123', 'dsh-auth-fixture=abc123'])
  expect(source.mints).toBe(1)
})

it('exchanges the tokenized URL the Host handed out, not a guessed one', async () => {
  const calls: string[] = []
  const source = authority({ token: 'process-token' })
  const cookie = createHostCookie({
    ...source,
    authorizeIndex: (request, response) => {
      calls.push(`${request.method} ${request.url} ${String(request.headers['host'])}`)
      return source.authorizeIndex(request, response)
    },
  })
  await cookie.read()
  expect(calls).toEqual(['GET /?token=process-token 127.0.0.1:53211'])
  void vi
})
