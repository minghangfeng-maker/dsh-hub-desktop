/**
 * Windows system proxy (WinINET) decoding and environment projection.
 *
 * The Harness reads proxy settings from process environment variables only, and
 * Chromium reads the Windows system proxy on its own. A desktop install on a
 * machine configured through the Windows proxy dialog therefore has a working
 * renderer and a direct Node.js side. This module turns the WinINET configuration
 * into the environment the Host and its child processes already consume, and it
 * never writes the registry or the user's files.
 *
 * WinINET stores the effective connection configuration in the binary
 * `DefaultConnectionSettings` value and duplicates parts of it in string values.
 * Flags decide which parts are live: a proxy string left behind from an earlier
 * configuration must not be used once its flag is clear, and PAC bytes in the
 * connection blob are residue unless the PAC flag is set.
 */

/** WinINET connection flags carried by `DefaultConnectionSettings`. */
export const WININET_PROXY_FLAGS = Object.freeze({
  /** Direct access is allowed. */
  direct: 0x01,
  /** A manually configured proxy server is used. */
  proxy: 0x02,
  /** An automatic configuration (PAC) script is used. */
  autoProxyUrl: 0x04,
  /** Proxy auto-detection (WPAD) is used. */
  autoDetect: 0x08,
})

/** One decoded `DefaultConnectionSettings` value. */
export interface WininetConnectionSettings {
  /** Structure version. */
  readonly version: number
  /** Change counter WinINET increments for every update. */
  readonly counter: number
  /** Connection flags; see {@link WININET_PROXY_FLAGS}. */
  readonly flags: number
  /** Raw proxy value, usually `host:port` or `scheme=host:port;…`. */
  readonly proxyServer: string
  /** Raw bypass list, `;`-separated. */
  readonly proxyBypass: string
  /** PAC URL the blob carries; empty unless the PAC flag is set. */
  readonly autoConfigUrl: string
  /** String layout the blob used. */
  readonly layout: 'length-prefixed' | 'nul-terminated'
  /** Diagnostics about bytes that were present but not live. */
  readonly diagnostics: readonly string[]
}

/** Proxy configuration accepted from the Windows settings, before environment projection. */
export interface WindowsSystemProxy {
  /** Manual proxy value; empty when no manual proxy is configured. */
  readonly proxyServer: string
  /** Bypass list, `;`-separated, as Windows stores it. */
  readonly proxyBypass: string
  /** PAC URL when a PAC is configured. */
  readonly autoConfigUrl: string
  /** Whether auto-detection (WPAD) is configured. */
  readonly autoDetect: boolean
  /** Diagnostics collected while decoding the Windows values. */
  readonly diagnostics: readonly string[]
}

/** Proxy environment projected from the Windows settings. */
export interface ProxyEnvironment {
  /** HTTP proxy URL, or undefined when requests go direct. */
  readonly httpProxy?: string | undefined
  /** HTTPS proxy URL, or undefined when requests go direct. */
  readonly httpsProxy?: string | undefined
  /** `NO_PROXY` value, or undefined when every target uses the proxy. */
  readonly noProxy?: string | undefined
  /** Diagnostics for entries that `NO_PROXY` cannot express. */
  readonly diagnostics: readonly string[]
}

/** Environment variable names that carry a user's own proxy configuration. */
export const USER_PROXY_ENVIRONMENT_NAMES = Object.freeze([
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
])

/** One decoded candidate layout of the connection blob. */
interface BlobStrings {
  /** How the three strings were laid out. */
  readonly layout: 'length-prefixed' | 'nul-terminated'
  /** Proxy server string. */
  readonly proxyServer: string
  /** Bypass list string. */
  readonly proxyBypass: string
  /** PAC URL string, which may be residue. */
  readonly autoConfigUrl: string
}

/** Decode printable ASCII and reject anything that cannot be a WinINET string. */
function printable(bytes: Uint8Array): string | undefined {
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e) return undefined
  }
  return Buffer.from(bytes).toString('latin1')
}

/**
 * Read three DWORD-length-prefixed strings, the layout current Windows builds write:
 * `[version][counter][flags][proxyLen][proxy][bypassLen][bypass][pacLen][pac]`.
 * @param bytes - Raw registry value.
 * @returns The three strings, or undefined when the lengths do not describe this layout.
 */
function lengthPrefixedStrings(bytes: Uint8Array): BlobStrings | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const read = (offset: number): { text: string; next: number } | undefined => {
    if (offset + 4 > bytes.byteLength) return undefined
    const length = view.getUint32(offset, true)
    if (length > bytes.byteLength - offset - 4) return undefined
    const text = printable(bytes.subarray(offset + 4, offset + 4 + length))
    return text === undefined ? undefined : { text, next: offset + 4 + length }
  }
  const proxy = read(12)
  if (proxy === undefined) return undefined
  const bypass = read(proxy.next)
  if (bypass === undefined) return undefined
  const pac = read(bypass.next)
  if (pac === undefined) return undefined
  return { layout: 'length-prefixed', proxyServer: proxy.text, proxyBypass: bypass.text, autoConfigUrl: pac.text }
}

/**
 * Read three NUL-terminated strings from offset 12, the layout recorded for older builds.
 * @param bytes - Raw registry value.
 * @returns The three strings, possibly empty when the value is shorter.
 */
function nulTerminatedStrings(bytes: Uint8Array): BlobStrings {
  const strings: string[] = []
  let start = 12
  while (strings.length < 3 && start < bytes.byteLength) {
    let end = start
    while (end < bytes.byteLength && bytes[end] !== 0) end += 1
    strings.push(Buffer.from(bytes.subarray(start, end)).toString('latin1'))
    start = end + 1
  }
  const [proxyServer = '', proxyBypass = '', autoConfigUrl = ''] = strings
  return { layout: 'nul-terminated', proxyServer, proxyBypass, autoConfigUrl }
}

/**
 * Decode `DefaultConnectionSettings`.
 * The flag word decides which parts are live. Windows has written the three strings
 * both as length-prefixed and as NUL-terminated values, so the reader accepts either
 * layout and prefers the length-prefixed one when its lengths describe the bytes.
 * @param bytes - Raw registry value.
 * @returns Decoded flags and the strings that follow them.
 * @throws {Error} When the value is too short to hold the documented header.
 */
export function parseDefaultConnectionSettings(bytes: Uint8Array): WininetConnectionSettings {
  if (bytes.byteLength < 12) throw new Error('desktop proxy: DefaultConnectionSettings is shorter than its header')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(0, true)
  const counter = view.getUint32(4, true)
  // The flag word occupies the four bytes at offset 8; only its low byte is defined.
  const flags = view.getUint32(8, true) & 0xff
  const decoded = lengthPrefixedStrings(bytes) ?? nulTerminatedStrings(bytes)
  const diagnostics: string[] = []
  const autoConfigUrl = (flags & WININET_PROXY_FLAGS.autoProxyUrl) === 0 ? '' : decoded.autoConfigUrl
  if ((flags & WININET_PROXY_FLAGS.autoProxyUrl) === 0 && decoded.autoConfigUrl !== '') {
    diagnostics.push('desktop proxy: ignoring the PAC URL in DefaultConnectionSettings because its flag is clear')
  }
  return {
    version, counter, flags, layout: decoded.layout,
    proxyServer: decoded.proxyServer, proxyBypass: decoded.proxyBypass, autoConfigUrl, diagnostics,
  }
}

/**
 * Read the manual proxy value into per-scheme proxy URLs.
 * @param value - `ProxyServer` string from the Windows settings.
 * @returns HTTP and HTTPS proxy URLs, or undefined for a scheme without a proxy.
 */
export function parseWindowsProxyServer(value: string): { http: string | undefined; https: string | undefined } {
  const entries = new Map<string, string>()
  for (const part of value.split(';')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const separator = trimmed.indexOf('=')
    if (separator === -1) {
      // A bare value applies to every protocol.
      const url = proxyUrlFor(trimmed)
      if (url !== undefined) { entries.set('http', url); entries.set('https', url) }
      continue
    }
    const scheme = trimmed.slice(0, separator).trim().toLowerCase()
    const endpoint = trimmed.slice(separator + 1).trim()
    const url = proxyUrlFor(endpoint)
    if (url === undefined) continue
    if (scheme === 'http') entries.set('http', url)
    else if (scheme === 'https') entries.set('https', url)
    else if (scheme === 'socks' || scheme === 'socks5') entries.set('socks', url)
  }
  const http = entries.get('http')
  const https = entries.get('https') ?? http
  return { http, https }
}

/**
 * Project one endpoint into a proxy URL the environment consumer accepts.
 * @param endpoint - `host:port` or `[::1]:port` without a scheme.
 * @returns Proxy URL, or undefined when the endpoint cannot be a proxy.
 */
function proxyUrlFor(endpoint: string): string | undefined {
  if (endpoint === '') return undefined
  // A `scheme://` prefix in the Windows value names the target protocol, not the proxy protocol.
  const bare = endpoint.includes('://') ? endpoint.slice(endpoint.indexOf('://') + 3) : endpoint
  if (/^\[[^\]]+\]:\d{1,5}$/u.test(bare) || /^[^\s:]+:\d{1,5}$/u.test(bare) || /^[^\s:]+$/u.test(bare)) {
    return `http://${bare}`
  }
  return undefined
}

/**
 * Convert a Windows bypass list into a `NO_PROXY` value.
 * Windows accepts wildcards (`127.*`) and the `<local>` token; `NO_PROXY` matches
 * hostnames and suffixes only, so a wildcard that stands for an address range is
 * dropped rather than turned into a suffix that would match unrelated hosts.
 * @param bypass - `;`-separated Windows bypass list.
 * @returns Accepted `NO_PROXY` entries and one diagnostic per dropped entry.
 */
export function convertWindowsProxyBypass(bypass: string): { entries: string[]; diagnostics: string[] } {
  const entries: string[] = []
  const diagnostics: string[] = []
  for (const part of bypass.split(';')) {
    const entry = part.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '<local>') {
      diagnostics.push('desktop proxy: dropped the "<local>" bypass entry because NO_PROXY has no equivalent')
      continue
    }
    if (entry.includes('*')) {
      if (entry === '127.*' || entry === 'localhost.*') {
        // Loopback is unconditional in the proxy policy; keep the intent visible in NO_PROXY.
        entries.push('127.0.0.1')
        entries.push('localhost')
        continue
      }
      diagnostics.push(`desktop proxy: dropped the address-range bypass entry ${JSON.stringify(entry)} because NO_PROXY cannot express it`)
      continue
    }
    entries.push(entry)
  }
  return { entries: [...new Set(entries)], diagnostics }
}

/**
 * Compose the proxy environment for one resolved Windows configuration.
 * @param settings - Proxy values already decoded from the registry.
 * @param resolved - Chromium's answer when an auto-configuration URL or auto-detection
 *   applies; `undefined` endpoints mean the resolver chose a direct connection. A
 *   resolved answer wins over the manual proxy, as it does in WinINET itself.
 * @returns Proxy variables to inject, plus diagnostics for entries that were dropped.
 */
export function composeProxyEnvironment(
  settings: WindowsSystemProxy,
  resolved?: { readonly http?: string | undefined; readonly https?: string | undefined }  ,
): ProxyEnvironment {
  const diagnostics = [...settings.diagnostics]
  const manual = parseWindowsProxyServer(settings.proxyServer)
  const http = resolved === undefined ? manual.http : resolved.http
  const https = resolved === undefined ? manual.https : resolved.https
  const bypass = convertWindowsProxyBypass(settings.proxyBypass)
  diagnostics.push(...bypass.diagnostics)
  if (http === undefined && https === undefined) {
    if (settings.autoConfigUrl !== '' || settings.autoDetect) {
      diagnostics.push('desktop proxy: the system configuration offers no proxy this client can use; requesting direct connections')
    }
    return { diagnostics }
  }
  return {
    ...http === undefined ? {} : { httpProxy: http },
    ...https === undefined ? {} : { httpsProxy: https },
    ...bypass.entries.length === 0 ? {} : { noProxy: bypass.entries.join(',') },
    diagnostics,
  }
}

/**
 * Report whether the given environment already carries a user proxy configuration.
 * @param environment - Host environment inherited from the launcher.
 * @returns The first configured variable name, or undefined when none is set.
 */
export function userProxyVariable(environment: Readonly<Record<string, string | undefined>>): string | undefined {
  return USER_PROXY_ENVIRONMENT_NAMES.find(name => (environment[name] ?? '').trim() !== '')
}
