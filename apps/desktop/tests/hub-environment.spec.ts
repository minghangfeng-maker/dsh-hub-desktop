import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  composeHubHostEnvironment, pipConfigurationPresent, proxyProbeOrigin, resolveHubRuntimeLayout,
  verifyBundledPwsh, DEFAULT_PIP_INDEX_URL, DEFAULT_PIP_TRUSTED_HOST,
} from '../src/hub-environment.ts'

const roots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hub-environment-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Create a packaged `resources/runtime` tree with the given bundled runtimes. */
function packagedResources(options: { pwsh?: boolean; python?: boolean; hubPlugins?: boolean }): string {
  const resources = join(temporaryRoot(), 'resources')
  const runtime = join(resources, 'runtime')
  if (options.pwsh === true) {
    const root = join(runtime, 'pwsh')
    mkdirSync(join(root, '7.6.7'), { recursive: true })
    writeFileSync(join(root, '7.6.7', 'pwsh.exe'), '')
    writeFileSync(join(root, 'runtime.json'), JSON.stringify({
      schemaVersion: 1, version: '7.6.7', directory: '7.6.7',
      sha256: 'd2f952ebdbf24386cb8923553aa58e41a846db35a6155ea04c58142a4b16dbb7',
    }))
  }
  if (options.python === true) {
    const python = join(runtime, 'primary-runtime', 'dependencies', 'python')
    mkdirSync(join(python, 'Scripts'), { recursive: true })
    writeFileSync(join(python, 'python.exe'), '')
  }
  if (options.hubPlugins === true) mkdirSync(join(runtime, 'hub-plugins'), { recursive: true })
  return resources
}

describe('runtime layout', () => {
  it('finds every bundled runtime of a packaged build', () => {
    const resources = packagedResources({ pwsh: true, python: true, hubPlugins: true })
    const layout = resolveHubRuntimeLayout({ packaged: true, resourcesPath: resources, appPath: resources })
    expect(layout.pwsh).toMatchObject({ version: '7.6.7' })
    expect(layout.pwsh?.directory).toBe(join(resources, 'runtime', 'pwsh', '7.6.7'))
    expect(layout.pythonDirectory).toBe(join(resources, 'runtime', 'primary-runtime', 'dependencies', 'python'))
    expect(layout.hubPluginsDirectory).toBe(join(resources, 'runtime', 'hub-plugins'))
  })

  it('reports nothing for a build without bundled runtimes', () => {
    const resources = join(temporaryRoot(), 'resources')
    expect(resolveHubRuntimeLayout({ packaged: true, resourcesPath: resources, appPath: resources })).toEqual({})
  })

  it('ignores a PowerShell descriptor whose directory has no executable', () => {
    const resources = packagedResources({ pwsh: true })
    rmSync(join(resources, 'runtime', 'pwsh', '7.6.7', 'pwsh.exe'))
    expect(resolveHubRuntimeLayout({ packaged: true, resourcesPath: resources, appPath: resources }).pwsh).toBeUndefined()
  })
})

describe('PowerShell self-check', () => {
  it('reports a missing executable instead of throwing', async () => {
    const check = await verifyBundledPwsh(join(temporaryRoot(), 'missing', 'pwsh.exe'), '7.6.7', 5_000)
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('could not start')
  })
})

describe('Host environment composition', () => {
  const base = { PATH: 'C:\\Windows\\system32' }
  /** Bundled layout with the interpreter directory a Windows install really has. */
  function bundledLayout(): { pwsh: { directory: string; version: string; sha256: string }; pythonDirectory: string } {
    const runtime = join(temporaryRoot(), 'runtime')
    const pythonDirectory = join(runtime, 'primary-runtime', 'dependencies', 'python')
    mkdirSync(join(pythonDirectory, 'Scripts'), { recursive: true })
    return {
      pwsh: { directory: join(runtime, 'pwsh', '7.6.7'), version: '7.6.7', sha256: 'a'.repeat(64) },
      pythonDirectory,
    }
  }
  // Each test owns a fresh tree: the file-level cleanup removes every temporary root.
  let layout: ReturnType<typeof bundledLayout>
  beforeEach(() => { layout = bundledLayout() })

  it('puts the bundled Python first on PATH and enables UTF-8 mode', () => {
    const composed = composeHubHostEnvironment({
      base, platform: 'win32', layout, pwshVerified: true, pythonUtf8: true, pipConfigPresent: false,
    })
    expect(composed.environment.PATH).toBe(`${layout.pythonDirectory}${delimiter}${join(layout.pythonDirectory, 'Scripts')}${delimiter}${base.PATH}`)
    expect(composed.environment.PYTHONUTF8).toBe('1')
    expect(composed.environment.PYTHONIOENCODING).toBe('utf-8')
  })

  it('keeps the interpreter defaults when the local setting disables UTF-8 mode', () => {
    const composed = composeHubHostEnvironment({
      base, platform: 'win32', layout, pwshVerified: true, pythonUtf8: false, pipConfigPresent: false,
    })
    expect(composed.environment.PYTHONUTF8).toBeUndefined()
    expect(composed.environment.PYTHONIOENCODING).toBeUndefined()
    expect(composed.diagnostics.join(' ')).toContain('UTF-8 mode is disabled')
  })

  it('injects the default pip index only when the user has no pip configuration', () => {
    const injected = composeHubHostEnvironment({
      base, platform: 'win32', layout, pwshVerified: true, pythonUtf8: true, pipConfigPresent: false,
    })
    expect(injected.environment.PIP_INDEX_URL).toBe(DEFAULT_PIP_INDEX_URL)
    expect(injected.environment.PIP_TRUSTED_HOST).toBe(DEFAULT_PIP_TRUSTED_HOST)
    const respected = composeHubHostEnvironment({
      base, platform: 'win32', layout, pwshVerified: true, pythonUtf8: true, pipConfigPresent: true,
    })
    expect(respected.environment.PIP_INDEX_URL).toBeUndefined()
    expect(respected.diagnostics.join(' ')).toContain('no package index')
  })

  it('never overrides a pip index the user already set', () => {
    const composed = composeHubHostEnvironment({
      base: { ...base, PIP_INDEX_URL: 'https://mirror.example/simple' },
      platform: 'win32', layout, pwshVerified: true, pythonUtf8: true, pipConfigPresent: false,
    })
    expect(composed.environment.PIP_INDEX_URL).toBe('https://mirror.example/simple')
  })

  it('points the shell at the bundled PowerShell and opts out of its telemetry', () => {
    const composed = composeHubHostEnvironment({
      base, platform: 'win32', layout, pwshVerified: true, pythonUtf8: true, pipConfigPresent: false,
    })
    expect(composed.environment.DSH_PWSH_PATH).toBe(join(layout.pwsh.directory, 'pwsh.exe'))
    expect(composed.environment.POWERSHELL_TELEMETRY_OPTOUT).toBe('1')
    expect(composed.environment.POWERSHELL_UPDATECHECK).toBe('Off')
    expect(composed.environment.DOTNET_CLI_TELEMETRY_OPTOUT).toBe('1')
    expect(composed.environment.NO_COLOR).toBe('1')
  })

  it('falls back to the upstream resolution chain when the self-check failed', () => {
    const composed = composeHubHostEnvironment({
      base, platform: 'win32', layout, pwshVerified: false, pythonUtf8: true, pipConfigPresent: false,
    })
    expect(composed.environment.DSH_PWSH_PATH).toBeUndefined()
    expect(composed.environment.POWERSHELL_TELEMETRY_OPTOUT).toBeUndefined()
    expect(composed.diagnostics.join(' ')).toContain('self-check')
  })

  it('contributes no Windows runtime values on another platform', () => {
    const composed = composeHubHostEnvironment({
      base, platform: 'darwin', layout, pwshVerified: true, pythonUtf8: true, pipConfigPresent: false,
    })
    expect(composed.environment.PATH).toBe(base.PATH)
    expect(composed.environment.DSH_PWSH_PATH).toBeUndefined()
    expect(composed.environment.PYTHONUTF8).toBeUndefined()
  })

  it('injects the system proxy under both spellings', () => {
    const composed = composeHubHostEnvironment({
      base, platform: 'win32', layout, pwshVerified: true, pythonUtf8: true, pipConfigPresent: false,
      proxy: { httpProxy: 'http://127.0.0.1:8080', httpsProxy: 'http://127.0.0.1:8080', noProxy: 'localhost', diagnostics: [] },
    })
    expect(composed.environment.HTTP_PROXY).toBe('http://127.0.0.1:8080')
    expect(composed.environment.http_proxy).toBe('http://127.0.0.1:8080')
    expect(composed.environment.NO_PROXY).toBe('localhost')
    expect(composed.diagnostics.join(' ')).toContain('Windows system proxy')
  })

  it('lets a Hub-delivered policy outrank the system proxy', () => {
    const composed = composeHubHostEnvironment({
      base, platform: 'win32', layout, pwshVerified: true, pythonUtf8: true, pipConfigPresent: false,
      proxy: { httpProxy: 'http://127.0.0.1:8080', httpsProxy: 'http://127.0.0.1:8080', diagnostics: [] },
      proxyOverride: { http: 'http://corp.example:8080', https: 'http://corp.example:8080', noProxy: 'localhost' },
    })
    expect(composed.environment.HTTPS_PROXY).toBe('http://corp.example:8080')
    expect(composed.environment.http_proxy).toBe('http://corp.example:8080')
    expect(composed.environment.NO_PROXY).toBe('localhost')
    expect(composed.diagnostics.join(' ')).toContain('Hub overlay')
  })

  it('keeps a proxy the user already configured', () => {
    const composed = composeHubHostEnvironment({
      base: { ...base, HTTPS_PROXY: 'http://corp:8080' },
      platform: 'win32', layout, pwshVerified: true, pythonUtf8: true, pipConfigPresent: false,
      proxy: { httpsProxy: 'http://127.0.0.1:8080', diagnostics: [] },
    })
    expect(composed.environment.https_proxy).toBeUndefined()
    expect(composed.diagnostics.join(' ')).toContain('HTTPS_PROXY is already set')
  })
})

describe('pip configuration detection', () => {
  it('reports an existing pip.ini under either documented directory', () => {
    const roaming = temporaryRoot()
    const profile = temporaryRoot()
    expect(pipConfigurationPresent({ APPDATA: roaming, USERPROFILE: profile })).toBe(false)
    mkdirSync(join(profile, 'pip'), { recursive: true })
    writeFileSync(join(profile, 'pip', 'pip.ini'), '[global]\n')
    expect(pipConfigurationPresent({ APPDATA: roaming, USERPROFILE: profile })).toBe(true)
    expect(pipConfigurationPresent({})).toBe(false)
  })
})

describe('PAC probe origin', () => {
  it('probes the Hub when the build has one and the model endpoint otherwise', () => {
    expect(proxyProbeOrigin('https://hub.example')).toBe('https://hub.example/')
    expect(proxyProbeOrigin('')).toBe('https://api.deepseek.com/')
  })
})
