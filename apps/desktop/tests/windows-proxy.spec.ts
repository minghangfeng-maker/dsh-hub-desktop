import { describe, expect, it } from 'vitest'
import {
  WININET_PROXY_FLAGS, composeProxyEnvironment, convertWindowsProxyBypass, parseDefaultConnectionSettings,
  parseWindowsProxyServer, userProxyVariable, type WindowsSystemProxy,
} from '../src/windows-proxy.ts'

/** Build one `DefaultConnectionSettings` value in either string layout. */
function connectionSettings(
  options: { flags: number; proxy?: string; bypass?: string; pac?: string }, layout: 'nul' | 'length' = 'length',
): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt32LE(70, 0)
  header.writeUInt32LE(3, 4)
  header.writeUInt32LE(options.flags, 8)
  const strings = [options.proxy ?? '', options.bypass ?? '', options.pac ?? '']
  if (layout === 'nul') return Buffer.concat([header, Buffer.from(`${strings.join('\0')}\0`, 'latin1')])
  const parts: Buffer[] = []
  for (const text of strings) {
    const length = Buffer.alloc(4)
    length.writeUInt32LE(Buffer.byteLength(text), 0)
    parts.push(length, Buffer.from(text, 'latin1'))
  }
  return Buffer.concat([header, ...parts])
}

describe('WinINET connection settings', () => {
  it('reads the flags and the manual proxy strings', () => {
    const decoded = parseDefaultConnectionSettings(connectionSettings({
      flags: WININET_PROXY_FLAGS.direct | WININET_PROXY_FLAGS.proxy,
      proxy: '127.0.0.1:8080',
      bypass: 'localhost;127.*;<local>',
    }))
    expect(decoded.flags).toBe(0x03)
    expect(decoded.layout).toBe('length-prefixed')
    expect(decoded.proxyServer).toBe('127.0.0.1:8080')
    expect(decoded.proxyBypass).toBe('localhost;127.*;<local>')
    expect(decoded.autoConfigUrl).toBe('')
    expect(decoded.diagnostics).toEqual([])
  })

  it('ignores PAC bytes while the PAC flag is clear', () => {
    const decoded = parseDefaultConnectionSettings(connectionSettings({
      flags: WININET_PROXY_FLAGS.direct | WININET_PROXY_FLAGS.proxy,
      proxy: '127.0.0.1:8080',
      pac: 'http://127.0.0.1:10812/pac?t=1',
    }))
    expect(decoded.autoConfigUrl).toBe('')
    expect(decoded.diagnostics.join(' ')).toContain('PAC URL')
  })

  it('reports the PAC URL once its flag is set', () => {
    const decoded = parseDefaultConnectionSettings(connectionSettings({
      flags: WININET_PROXY_FLAGS.autoProxyUrl, pac: 'http://wg.local/proxy.pac',
    }))
    expect(decoded.autoConfigUrl).toBe('http://wg.local/proxy.pac')
  })

  it('reads the NUL-terminated layout older builds wrote', () => {
    const decoded = parseDefaultConnectionSettings(connectionSettings({
      flags: WININET_PROXY_FLAGS.direct | WININET_PROXY_FLAGS.proxy, proxy: '10.0.0.1:3128', bypass: 'localhost',
    }, 'nul'))
    expect(decoded.layout).toBe('nul-terminated')
    expect(decoded.proxyServer).toBe('10.0.0.1:3128')
    expect(decoded.proxyBypass).toBe('localhost')
  })

  it('decodes a recorded Windows 11 value', () => {
    // HKCU\...\Internet Settings\Connections\DefaultConnectionSettings, Windows 11 26300:
    // flags 0x03, proxy 127.0.0.1:8080, a long bypass list, and PAC residue whose flag is clear.
    const hex = '46000000d1190000030000000e0000003132372e302e302e313a38303830'
      + '170000006c6f63616c686f73743b3132372e2a3b3c6c6f63616c3e'
      + '1a000000687474703a2f2f3132372e302e302e313a31303838312f706163'
    const decoded = parseDefaultConnectionSettings(Buffer.from(hex, 'hex'))
    expect(decoded.flags).toBe(0x03)
    expect(decoded.proxyServer).toBe('127.0.0.1:8080')
    expect(decoded.proxyBypass).toBe('localhost;127.*;<local>')
    expect(decoded.autoConfigUrl).toBe('')
    expect(decoded.diagnostics.join(' ')).toContain('PAC URL')
  })

  it('rejects a value shorter than its header', () => {
    expect(() => parseDefaultConnectionSettings(Buffer.alloc(8))).toThrow(/shorter than its header/u)
  })
})

describe('Windows proxy values', () => {
  it('applies a bare endpoint to both protocols', () => {
    expect(parseWindowsProxyServer('127.0.0.1:8080')).toEqual({ http: 'http://127.0.0.1:8080', https: 'http://127.0.0.1:8080' })
  })

  it('splits per-protocol endpoints and ignores unsupported protocols', () => {
    expect(parseWindowsProxyServer('http=proxy.local:8080;https=secure.local:8443;socks=socks.local:1080')).toEqual({
      http: 'http://proxy.local:8080',
      https: 'http://secure.local:8443',
    })
  })

  it('falls back to the HTTP endpoint for HTTPS', () => {
    expect(parseWindowsProxyServer('http=proxy.local:8080')).toEqual({ http: 'http://proxy.local:8080', https: 'http://proxy.local:8080' })
  })

  it('keeps hostnames and drops <local> and address-range wildcards', () => {
    const converted = convertWindowsProxyBypass('localhost;127.*;192.168.*;10.*;*.corp.example;<local>;LOCALHOST')
    expect(converted.entries).toEqual(['localhost', '127.0.0.1'])
    expect(converted.diagnostics).toHaveLength(4)
  })

  it('drops a wildcard host pattern because NO_PROXY has no wildcard syntax', () => {
    const converted = convertWindowsProxyBypass('*.corp.example')
    expect(converted.entries).toEqual([])
    expect(converted.diagnostics.join(' ')).toContain('*.corp.example')
  })
})

describe('proxy environment', () => {
  const manual: WindowsSystemProxy = {
    proxyServer: '127.0.0.1:8080', proxyBypass: 'localhost;127.*;<local>', autoConfigUrl: '', autoDetect: false,
    diagnostics: [],
  }

  it('projects a manual proxy into both schemes and the bypass list', () => {
    expect(composeProxyEnvironment(manual)).toEqual({
      httpProxy: 'http://127.0.0.1:8080',
      httpsProxy: 'http://127.0.0.1:8080',
      noProxy: 'localhost,127.0.0.1',
      diagnostics: [expect.stringContaining('<local>')],
    })
  })

  it('prefers a resolved answer over the manual proxy', () => {
    expect(composeProxyEnvironment(manual, { http: 'http://192.0.2.9:3128', https: 'http://192.0.2.9:3128' })).toMatchObject({
      httpProxy: 'http://192.0.2.9:3128',
      httpsProxy: 'http://192.0.2.9:3128',
    })
  })

  it('treats a resolved answer without endpoints as direct access', () => {
    const composed = composeProxyEnvironment(manual, {})
    expect(composed.httpProxy).toBeUndefined()
    expect(composed.httpsProxy).toBeUndefined()
    // The dropped bypass entries stay reported even though no proxy is used.
    expect(composed.diagnostics.join(' ')).toContain('<local>')
  })

  it('reports direct access when the configuration offers no usable proxy', () => {
    const composed = composeProxyEnvironment({ ...manual, proxyServer: '', autoDetect: true })
    expect(composed.httpProxy).toBeUndefined()
    expect(composed.diagnostics.join(' ')).toContain('direct connections')
  })

  it('recognizes a user proxy configuration in either spelling', () => {
    expect(userProxyVariable({ HTTPS_PROXY: 'http://corp:8080' })).toBe('HTTPS_PROXY')
    expect(userProxyVariable({ http_proxy: 'http://corp:8080' })).toBe('http_proxy')
    expect(userProxyVariable({ http_proxy: '  ' })).toBeUndefined()
    expect(userProxyVariable({})).toBeUndefined()
  })
})
