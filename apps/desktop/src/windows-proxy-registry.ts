/**
 * Windows system proxy discovery for the Electron shell.
 *
 * The shell reads the current user's WinINET configuration from the registry with
 * `reg.exe query` (read-only, no elevated rights) and asks Chromium to resolve an
 * auto-configuration script when one is configured. Nothing here executes a PAC
 * file itself and nothing writes the registry.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  parseDefaultConnectionSettings, WININET_PROXY_FLAGS, type WindowsSystemProxy,
} from './windows-proxy.ts'

/** Registry key holding the current user's WinINET connection settings. */
export const WININET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** Subkey holding the per-LAN connection blob, including `DefaultConnectionSettings`. */
export const WININET_CONNECTIONS_KEY = `${WININET_SETTINGS_KEY}\\Connections`

/** One decoded registry value. */
export interface RegistryValue {
  /** Windows value type, for example `REG_SZ` or `REG_BINARY`. */
  readonly type: string
  /** Value text: the string itself, a hexadecimal byte string, or the DWORD literal. */
  readonly value: string
}

/**
 * Parse `reg.exe query <key>` output into its values.
 * Lines are indented and separated by runs of spaces; a value's data may be empty.
 * @param output - Command output.
 * @returns Value map keyed by value name.
 */
export function parseRegistryQuery(output: string): Map<string, RegistryValue> {
  const values = new Map<string, RegistryValue>()
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s{4,}(\S+)\s+(REG_[A-Z_]+)(?:\s+(.*))?$/u.exec(line)
    if (match === null) continue
    const name = match[1] ?? ''
    const type = match[2] ?? ''
    values.set(name, { type, value: match[3]?.trim() ?? '' })
  }
  return values
}

/**
 * Decode a `REG_BINARY` value.
 * @param hex - Hexadecimal digits, without separators.
 * @returns The decoded bytes.
 * @throws {Error} When the text is not an even-length hexadecimal string.
 */
export function decodeRegistryBinary(hex: string): Buffer {
  if (!/^[0-9a-fA-F]*$/u.test(hex) || hex.length % 2 !== 0) {
    throw new Error('desktop proxy: registry binary value is not hexadecimal')
  }
  return Buffer.from(hex, 'hex')
}

/** Reads one registry value set; injectable so the decoding stays testable. */
export type RegistryReader = (args: readonly string[]) => Promise<string>

/** Read the current user's WinINET settings with `reg.exe`. */
export const readRegistry: RegistryReader = async (args) => {
  const { stdout } = await promisify(execFile)('reg.exe', [...args], { windowsHide: true, encoding: 'utf8' })
  return stdout
}

/** A system proxy configuration and the Chromium resolution of its PAC, when any. */
export interface WindowsProxyDiscovery {
  /** Decoded configuration, or undefined when the system configures no proxy. */
  readonly settings?: WindowsSystemProxy | undefined
  /** Chromium's answer for the probe origin, when a PAC or auto-detection applies. */
  readonly resolved?: { readonly http?: string | undefined; readonly https?: string | undefined } | undefined
  /** Diagnostics from discovery and resolution. */
  readonly diagnostics: readonly string[]
}

/**
 * Decode the WinINET values into the configuration this build consumes.
 *
 * The binary `DefaultConnectionSettings` value decides which parts are live, so a
 * proxy string or PAC URL left behind by an earlier configuration is ignored while
 * its flag is clear. The string values are the fallback on systems that do not
 * write the binary value.
 * @param values - Parsed registry values.
 * @returns The decoded configuration, or undefined when nothing is enabled.
 */
export function decodeWininetSettings(values: Map<string, RegistryValue>): WindowsSystemProxy | undefined {
  const diagnostics: string[] = []
  const binary = values.get('DefaultConnectionSettings')
  const stringValue = (name: string): string => values.get(name)?.value ?? ''
  if (binary !== undefined && binary.type === 'REG_BINARY') {
    const connection = parseDefaultConnectionSettings(decodeRegistryBinary(binary.value))
    diagnostics.push(...connection.diagnostics)
    const manual = (connection.flags & WININET_PROXY_FLAGS.proxy) !== 0
    const autoConfigUrl = connection.autoConfigUrl
    const autoDetect = (connection.flags & WININET_PROXY_FLAGS.autoDetect) !== 0
    if (!manual && autoConfigUrl === '' && !autoDetect) return undefined
    return {
      proxyServer: manual ? connection.proxyServer : '',
      proxyBypass: manual ? connection.proxyBypass : '',
      autoConfigUrl,
      autoDetect,
      diagnostics,
    }
  }
  const enabled = stringValue('ProxyEnable') !== '' && stringValue('ProxyEnable') !== '0x0' && stringValue('ProxyEnable') !== '0'
  const proxyServer = enabled ? stringValue('ProxyServer') : ''
  const autoConfigUrl = stringValue('AutoConfigURL')
  if (proxyServer === '' && autoConfigUrl === '') return undefined
  diagnostics.push('desktop proxy: DefaultConnectionSettings is unavailable; using the string values')
  return { proxyServer, proxyBypass: enabled ? stringValue('ProxyOverride') : '', autoConfigUrl, autoDetect: false, diagnostics }
}

/**
 * Read the machine's system proxy configuration.
 * @param read - Registry reader; defaults to `reg.exe`.
 * @returns Decoded settings plus discovery diagnostics.
 */
export async function readWindowsSystemProxy(
  read: RegistryReader = readRegistry,
): Promise<WindowsProxyDiscovery> {
  let values: Map<string, RegistryValue>
  try {
    values = parseRegistryQuery(await read(['query', WININET_SETTINGS_KEY]))
  } catch (error) {
    return { diagnostics: [`desktop proxy: could not read the Windows proxy configuration: ${error instanceof Error ? error.message : String(error)}`] }
  }
  // Windows keeps the connection blob under the `Connections` subkey; a profile without
  // one is a machine that never opened the proxy dialog, which the string values cover.
  try {
    for (const [name, value] of parseRegistryQuery(await read(['query', WININET_CONNECTIONS_KEY]))) values.set(name, value)
  } catch {
    // An absent subkey is not an error: the string values above still describe the configuration.
  }
  const settings = decodeWininetSettings(values)
  // Decoding diagnostics travel with the settings themselves, so the caller reports each
  // one once; only a failed read has a diagnostic of its own.
  if (settings === undefined) return { diagnostics: [] }
  return { settings, diagnostics: [] }
}

/** One proxy token from Chromium's PAC result, for example `PROXY 127.0.0.1:8080`. */
function parseResolution(result: string): { readonly proxy?: string | undefined; readonly note?: string | undefined } {
  for (const token of result.split(';')) {
    const trimmed = token.trim()
    if (trimmed === '') continue
    const [type = '', endpoint = ''] = trimmed.split(/\s+/u)
    const kind = type.toUpperCase()
    if (kind === 'DIRECT') return {}
    if (kind === 'PROXY' || kind === 'HTTPS') return { proxy: `http://${endpoint}` }
    if (kind.startsWith('SOCKS')) {
      return { note: `desktop proxy: dropping the SOCKS proxy ${endpoint} from the PAC result because the Harness proxy policy supports HTTP proxies only` }
    }
  }
  return {}
}

/** Inputs for the PAC resolution step. */
export interface PacResolutionOptions {
  /** Whether the configured proxy needs Chromium to resolve it. */
  readonly needsResolution: boolean
  /** Origin to probe. */
  readonly probeOrigin: string
  /** Chromium resolver, normally `session.defaultSession.resolveProxy`. */
  readonly resolve: (url: string) => Promise<string>
}

/**
 * Resolve an auto-configured proxy through Chromium.
 * A PAC is JavaScript; the shell does not evaluate it, and Chromium already does.
 * @param options - Whether resolution applies, the origin to probe, and the resolver.
 * @returns Endpoints for both schemes plus any diagnostic.
 */
export async function resolveAutoProxy(
  options: PacResolutionOptions,
): Promise<{ readonly http?: string | undefined; readonly https?: string | undefined; readonly diagnostics: readonly string[] }> {
  if (!options.needsResolution) return { diagnostics: [] }
  try {
    const result = await options.resolve(options.probeOrigin)
    const parsed = parseResolution(result)
    if (parsed.note !== undefined) return { diagnostics: [parsed.note] }
    if (parsed.proxy === undefined) {
      return { diagnostics: [`desktop proxy: the system proxy resolves ${options.probeOrigin} to a direct connection`] }
    }
    return { http: parsed.proxy, https: parsed.proxy, diagnostics: [`desktop proxy: resolved ${options.probeOrigin} to ${parsed.proxy}`] }
  } catch (error) {
    return { diagnostics: [`desktop proxy: the system proxy could not be resolved: ${error instanceof Error ? error.message : String(error)}`] }
  }
}
