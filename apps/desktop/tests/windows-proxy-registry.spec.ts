import { describe, expect, it, vi } from 'vitest'
import {
  decodeRegistryBinary, decodeWininetSettings, parseRegistryQuery, readWindowsSystemProxy, resolveAutoProxy,
} from '../src/windows-proxy-registry.ts'

/** One `reg.exe query` block as Windows prints it. */
const QUERY = `\r
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r
    ProxyEnable    REG_DWORD    0x1\r
    ProxyServer    REG_SZ    127.0.0.1:8080\r
    ProxyOverride    REG_SZ    localhost;127.*;<local>\r
    DefaultConnectionSettings    REG_BINARY    460000000304000003000000000000003132372E302E302E313A37383937006C6F63616C686F737400\r
\r
`

/** Encode one `DefaultConnectionSettings` value as `reg.exe` prints it. */
function binaryValue(options: { flags: number; proxy?: string; bypass?: string; pac?: string }): string {
  const header = Buffer.alloc(12)
  header.writeUInt32LE(70, 0)
  header.writeUInt32LE(3, 4)
  header.writeUInt32LE(options.flags, 8)
  const strings = [options.proxy ?? '', options.bypass ?? '', options.pac ?? '']
  return Buffer.concat([header, Buffer.from(`${strings.join('\0')}\0`, 'latin1')]).toString('hex').toUpperCase()
}

describe('registry output', () => {
  it('parses values from a query block', () => {
    const values = parseRegistryQuery(QUERY)
    expect(values.get('ProxyEnable')).toEqual({ type: 'REG_DWORD', value: '0x1' })
    expect(values.get('ProxyServer')).toEqual({ type: 'REG_SZ', value: '127.0.0.1:8080' })
    expect(values.get('DefaultConnectionSettings')?.type).toBe('REG_BINARY')
  })

  it('rejects a binary value that is not hexadecimal', () => {
    expect(() => decodeRegistryBinary('zz')).toThrow(/not hexadecimal/u)
    expect(() => decodeRegistryBinary('abc')).toThrow(/not hexadecimal/u)
    expect(decodeRegistryBinary('00ff').toString('hex')).toBe('00ff')
  })
})

describe('WinINET settings decoding', () => {
  it('decides from the binary flags, not from the stale string values', () => {
    const values = parseRegistryQuery(`HKEY\r
    ProxyEnable    REG_DWORD    0x1\r
    ProxyServer    REG_SZ    10.0.0.1:8080\r
    DefaultConnectionSettings    REG_BINARY    ${binaryValue({ flags: 0x01 })}\r
`)
    expect(decodeWininetSettings(values)).toBeUndefined()
  })

  it('reads the manual proxy from the binary value when its flag is set', () => {
    const values = parseRegistryQuery(`HKEY\r
    DefaultConnectionSettings    REG_BINARY    ${binaryValue({ flags: 0x03, proxy: '127.0.0.1:8080', bypass: 'localhost;127.*' })}\r
`)
    expect(decodeWininetSettings(values)).toMatchObject({
      proxyServer: '127.0.0.1:8080',
      proxyBypass: 'localhost;127.*',
      autoConfigUrl: '',
      autoDetect: false,
    })
  })

  it('reports a PAC only when its flag is set', () => {
    const values = parseRegistryQuery(`HKEY\r
    DefaultConnectionSettings    REG_BINARY    ${binaryValue({ flags: 0x04, pac: 'http://wg/proxy.pac' })}\r
`)
    expect(decodeWininetSettings(values)).toMatchObject({ autoConfigUrl: 'http://wg/proxy.pac', proxyServer: '' })
  })

  it('falls back to the string values when the binary value is absent', () => {
    const values = parseRegistryQuery(`HKEY\r
    ProxyEnable    REG_DWORD    0x1\r
    ProxyServer    REG_SZ    proxy.local:8080\r
    ProxyOverride    REG_SZ    localhost\r
`)
    expect(decodeWininetSettings(values)).toMatchObject({ proxyServer: 'proxy.local:8080', proxyBypass: 'localhost' })
  })

  it('reports no configuration when everything is disabled', () => {
    const values = parseRegistryQuery('HKEY\r\n    ProxyEnable    REG_DWORD    0x0\r\n')
    expect(decodeWininetSettings(values)).toBeUndefined()
  })
})

describe('system proxy discovery', () => {
  it('reports an unreadable registry instead of failing startup', async () => {
    const discovery = await readWindowsSystemProxy(async () => { throw new Error('access denied') })
    expect(discovery.settings).toBeUndefined()
    expect(discovery.diagnostics.join(' ')).toContain('access denied')
  })

  it('reads the configuration through the injected query', async () => {
    // String values live in the settings key; the connection blob lives in its subkey.
    const read = vi.fn(async (args: readonly string[]) => (args[1] ?? '').endsWith('Connections')
      ? `HKEY\r
    DefaultConnectionSettings    REG_BINARY    ${binaryValue({ flags: 0x03, proxy: '127.0.0.1:8080' })}\r
`
      : 'HKEY\r\n    ProxyEnable    REG_DWORD    0x1\r\n')
    const discovery = await readWindowsSystemProxy(read)
    expect(read.mock.calls.map(([args]) => args[1])).toEqual([
      expect.stringContaining('Internet Settings'),
      expect.stringContaining('Connections'),
    ])
    expect(discovery.settings?.proxyServer).toBe('127.0.0.1:8080')
  })

  it('keeps the string values when the connection subkey is unavailable', async () => {
    const read = vi.fn(async (args: readonly string[]) => {
      if ((args[1] ?? '').endsWith('Connections')) throw new Error('no such key')
      return 'HKEY\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:8080\r\n'
    })
    const discovery = await readWindowsSystemProxy(read)
    expect(discovery.settings?.proxyServer).toBe('127.0.0.1:8080')
    expect(discovery.settings?.diagnostics.join(' ')).toContain('string values')
  })
})

describe('PAC resolution', () => {
  it('maps a PROXY answer to an endpoint for both schemes', async () => {
    const resolved = await resolveAutoProxy({ needsResolution: true, probeOrigin: 'https://hub.example/',
      resolve: async () => 'PROXY 127.0.0.1:8080; DIRECT' })
    expect(resolved).toMatchObject({ http: 'http://127.0.0.1:8080', https: 'http://127.0.0.1:8080' })
  })

  it('leaves direct access in place when Chromium answers DIRECT', async () => {
    const resolved = await resolveAutoProxy({ needsResolution: true, probeOrigin: 'https://hub.example/', resolve: async () => 'DIRECT' })
    expect(resolved.http).toBeUndefined()
    expect(resolved.diagnostics.join(' ')).toContain('direct connection')
  })

  it('drops a SOCKS answer with a diagnostic', async () => {
    const resolved = await resolveAutoProxy({ needsResolution: true, probeOrigin: 'https://hub.example/',
      resolve: async () => 'SOCKS5 127.0.0.1:1080' })
    expect(resolved.http).toBeUndefined()
    expect(resolved.diagnostics.join(' ')).toContain('SOCKS')
  })

  it('reports a resolver failure without failing startup', async () => {
    const resolved = await resolveAutoProxy({ needsResolution: true, probeOrigin: 'https://hub.example/',
      resolve: async () => { throw new Error('no PAC') } })
    expect(resolved.diagnostics.join(' ')).toContain('no PAC')
  })

  it('does nothing when no resolution applies', async () => {
    await expect(resolveAutoProxy({ needsResolution: false, probeOrigin: 'https://hub.example/',
      resolve: async () => 'PROXY 127.0.0.1:1' })).resolves.toEqual({ diagnostics: [] })
  })
})
