/**
 * The connector's HTTP face toward the Hub.
 *
 * Every desktop request uses the same three rules: HTTPS or a loopback origin, a
 * bearer device token when the endpoint needs identity, and a bounded timeout so
 * a stuck Hub never wedges the Host. Responses are parsed as JSON and a Hub error
 * body (`{error:{code,message,details}}`) becomes a
 * {@link HubRequestError} carrying the machine-readable code — callers branch on
 * the code, never on the localized message.
 */

/** Machine-readable failure from the Hub, or from the transport carrying it. */
export class HubRequestError extends Error {
  /**
   * @param code - Hub error code, or a local transport code (`no-response`, `timeout`, `invalid-body`).
   * @param message - Operator-facing text (the Hub's own message when it answered).
   * @param status - HTTP status, or 0 when no response arrived.
   * @param details - Hub `details` object, unvalidated.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> | undefined = undefined,
  ) {
    super(`${code}: ${message}`)
    this.name = 'HubRequestError'
  }
}

/** Default request timeout; a heartbeat or manifest pull is small and local-network sized. */
const DEFAULT_TIMEOUT_MS = 20_000

/** How much of an error body to read before giving up on parsing it. */
const MAX_ERROR_BODY_BYTES = 64 * 1024

/**
 * Accept only an origin the login rules allow: HTTPS anywhere, plain HTTP only on loopback.
 * @param value - Candidate Hub origin.
 * @returns The normalized origin without a trailing slash.
 * @throws {HubRequestError} When the value is not an absolute origin or breaks the transport rule.
 */
export function normalizeHubOrigin(value: string): string {
  const trimmed = value.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new HubRequestError('invalid-origin', `"${trimmed}" is not an absolute URL`, 0)
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new HubRequestError('invalid-origin', 'a Hub origin carries no credentials, query, or fragment', 0)
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new HubRequestError('invalid-origin', 'the Hub requires HTTPS, or plain HTTP on a loopback address', 0)
  }
  const path = url.pathname.replace(/\/+$/u, '')
  return `${url.origin}${path}`
}

/** Narrow an unknown value to a plain record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read one Hub error body, keeping the code that callers branch on.
 * @param response - Non-2xx response.
 * @returns The failure to throw.
 */
async function failureOf(response: Response): Promise<HubRequestError> {
  let text = ''
  try {
    const buffer = await response.arrayBuffer()
    text = Buffer.from(buffer.slice(0, MAX_ERROR_BODY_BYTES)).toString('utf8')
  } catch {
    // A body that cannot be read still carries the status; report that instead.
    return new HubRequestError('http-error', response.statusText === '' ? 'request failed' : response.statusText, response.status)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return new HubRequestError('http-error', `HTTP ${String(response.status)}`, response.status)
  }
  const error = record(record(parsed)?.error)
  const code = typeof error?.code === 'string' ? error.code : 'http-error'
  const message = typeof error?.message === 'string' ? error.message : `HTTP ${String(response.status)}`
  return new HubRequestError(code, message, response.status, record(error?.details))
}

/** One request description. */
export interface HubRequest {
  /** Absolute URL. */
  readonly url: string
  /** HTTP method. */
  readonly method?: 'GET' | 'POST'
  /** JSON body; omitted for GET. */
  readonly body?: unknown
  /** Device token to send as a bearer credential. */
  readonly token?: string
  /** Additional headers, such as `If-None-Match`. */
  readonly headers?: Readonly<Record<string, string>>
  /** Per-request timeout override. */
  readonly timeoutMs?: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal
}

/** One request outcome, including the headers callers need (ETag). */
export interface HubResponse<T> {
  /** Parsed JSON body; `undefined` for 304 and for empty bodies. */
  readonly body: T | undefined
  /** HTTP status. */
  readonly status: number
  /** `ETag` response header, when the Hub sent one. */
  readonly etag: string | undefined
}

/**
 * Perform one JSON request against the Hub.
 * @param request - URL, method, body, credential, and limits.
 * @returns Parsed body, status, and ETag.
 * @throws {HubRequestError} On a transport failure, timeout, non-JSON body, or non-2xx answer.
 */
export async function hubRequest<T>(request: HubRequest): Promise<HubResponse<T>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = request.signal === undefined
    ? controller.signal
    : AbortSignal.any([request.signal, controller.signal])
  const headers: Record<string, string> = { accept: 'application/json', ...request.headers }
  if (request.token !== undefined && request.token !== '') headers.authorization = `Bearer ${request.token}`
  if (request.body !== undefined) headers['content-type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers,
      // A redirect can only take a bearer credential somewhere it was not meant to go.
      redirect: 'error',
      signal,
      ...request.body === undefined ? {} : { body: JSON.stringify(request.body) },
    })
  } catch (error) {
    const timedOut = controller.signal.aborted
    throw new HubRequestError(
      timedOut ? 'timeout' : 'no-response',
      timedOut ? 'the Hub did not answer in time' : error instanceof Error ? error.message : String(error),
      0,
    )
  } finally {
    clearTimeout(timeout)
  }
  if (response.status === 304) {
    return { body: undefined, status: 304, etag: response.headers.get('etag') ?? undefined }
  }
  if (!response.ok) throw await failureOf(response)
  const text = await response.text()
  if (text.trim() === '') return { body: undefined, status: response.status, etag: response.headers.get('etag') ?? undefined }
  let parsed: T
  try {
    parsed = JSON.parse(text) as T
  } catch {
    throw new HubRequestError('invalid-body', 'the Hub answered with a body that is not JSON', response.status)
  }
  return { body: parsed, status: response.status, etag: response.headers.get('etag') ?? undefined }
}

/**
 * Whether a failure means the stored device token is no longer usable.
 * @param error - Failure from {@link hubRequest}.
 * @returns True for 401, and for the Hub's explicit `DEVICE_TOKEN_INVALID` on any status.
 */
export function isDeviceTokenInvalid(error: unknown): boolean {
  if (!(error instanceof HubRequestError)) return false
  if (error.code === 'DEVICE_TOKEN_INVALID') return true
  return error.status === 401 && error.code !== 'RATE_LIMITED'
}
