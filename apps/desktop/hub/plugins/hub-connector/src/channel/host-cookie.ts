/**
 * The local Host credential the desktop relay's adapter uses.
 *
 * The Host admits `/api` and `/api/remote.mux` only with the browser cookie it
 * issued for this process, so the desktop mints one in-process instead of guessing
 * that loopback is exempt: take the tokenized URL from `ctx.connection`, exchange it
 * for a `Set-Cookie` through `authorizeIndex`, and keep only the cookie pair. The
 * value never reaches the renderer, a log line, or the status route.
 */

/** The two Connection members minting a cookie needs. */
export interface HostCookieAuthority {
  /** Origin the Host serves, for example `http://127.0.0.1:53211`. */
  readonly origin: () => string
  /** Tokenized application URL for one origin. */
  readonly authenticatedUrl: (origin: string) => string
  /** Index authorization that mints the browser cookie; false when it refused. */
  readonly authorizeIndex: (request: {
    readonly method: string
    readonly url: string
    readonly headers: Readonly<Record<string, string>>
  }, response: {
      writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
      end(body?: string): unknown
    }) => boolean
}

/** What the adapter's default transport asks for. */
export interface HostCookie {
  /**
   * Current `cookie` header value, minted on first use.
   * @returns the header value; empty only when the Host has no Web client.
   */
  read(): Promise<string>
  /** Drop the cached value, so the next read mints a fresh one. */
  invalidate(): void
}

/**
 * Reduce one `Set-Cookie` value to the request header pair.
 * @param setCookie - raw `Set-Cookie` header value.
 * @returns `name=value`, or '' when the header names no cookie.
 */
export function cookiePairOf(setCookie: string): string {
  const pair = setCookie.split(';', 1)[0]?.trim() ?? ''
  const separator = pair.indexOf('=')
  return separator > 0 ? pair : ''
}

/**
 * Build the cookie source for one Host process.
 * @param authority - Connection members of the Host.
 * @returns a cookie reader that mints on demand and can be invalidated.
 */
export function createHostCookie(authority: HostCookieAuthority): HostCookie {
  let cached: string | undefined
  let pending: Promise<string> | undefined

  /** Exchange the process token once and return the cookie pair. */
  const mint = async (): Promise<string> => {
    const origin = authority.origin()
    const target = new URL(authority.authenticatedUrl(origin))
    let status: number | undefined
    let setCookie: string | undefined
    // The return value describes whether the caller may now serve index.html: a
    // minted cookie comes back as `false` after a 303 with `Set-Cookie`, and `true`
    // only means "an existing cookie already passed". The response decides, not it.
    authority.authorizeIndex({
      method: 'GET',
      url: `${target.pathname}${target.search}`,
      headers: { host: target.host },
    }, {
      writeHead(value, headers) {
        status = value
        const header = headers?.['set-cookie']
        if (typeof header === 'string') setCookie = header
      },
      end() {},
    })
    const pair = setCookie === undefined ? '' : cookiePairOf(setCookie)
    if (pair === '') {
      throw new Error(`host cookie: the Host minted no cookie (status ${String(status ?? 'none')})`)
    }
    return pair
  }

  return {
    invalidate() {
      cached = undefined
      pending = undefined
    },
    async read() {
      if (cached !== undefined) return cached
      // Concurrent readers share one exchange so a burst of callers performs one
      // authorization round trip. Whether two exchanges produce the same value is a
      // property of the Host's signed cookie, not something this client relies on.
      pending ??= mint().then((pair) => {
        cached = pair
        return pair
      }).finally(() => { pending = undefined })
      return await pending
    },
  }
}
