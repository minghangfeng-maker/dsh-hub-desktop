/**
 * Host environment for a DSH Hub build: bundled PowerShell, bundled Python, and
 * the proxy the operating system is configured with.
 *
 * The Electron shell owns this composition because the values are build- and
 * machine-specific runtime facts: the Host subprocess and every agent shell
 * inherit what this module returns, and nothing here writes the user's files or
 * the registry. Values the user already set in the environment always win, which
 * keeps a machine-local override possible without touching the build.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import {
  composeProxyEnvironment, userProxyVariable, type ProxyEnvironment, type WindowsSystemProxy,
} from './windows-proxy.ts'
import type { HubProxyOverride } from './hub-overlay.ts'

/** Directory of the bundled PowerShell runtime under `resources/runtime`. */
export const BUNDLED_PWSH_DIRECTORY = 'pwsh'

/** Descriptor the build writes beside the bundled PowerShell versions. */
export const BUNDLED_PWSH_MANIFEST = 'runtime.json'

/** Default package index for the bundled pip; the Hub may deliver an override. */
export const DEFAULT_PIP_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple'

/** Host of {@link DEFAULT_PIP_INDEX_URL}, trusted explicitly for TLS-inspecting corporate networks. */
export const DEFAULT_PIP_TRUSTED_HOST = 'pypi.tuna.tsinghua.edu.cn'

/** Regex-free plain names the environment composes. */
const TELEMETRY_OPTOUT = {
  POWERSHELL_TELEMETRY_OPTOUT: '1',
  POWERSHELL_UPDATECHECK: 'Off',
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
} as const

/** Bundled PowerShell descriptor written by the packaging step. */
export interface PwshRuntimeManifest {
  /** PowerShell version the directory contains. */
  readonly version: string
  /** SHA-256 of the archive the directory was extracted from. */
  readonly sha256: string
  /** Directory name under `runtime/pwsh` holding the executable. */
  readonly directory: string
}

/** Bundled PowerShell the package carries, with the identity its build declared. */
export interface BundledPwsh {
  /** Absolute version directory holding `pwsh.exe`. */
  readonly directory: string
  /** Version the build declared. */
  readonly version: string
  /** SHA-256 of the archive the directory was extracted from. */
  readonly sha256: string
}

/** Directories of the bundled runtimes this module exposes to the Host. */
export interface HubRuntimeLayout {
  /** Bundled PowerShell, when the package carries one. */
  readonly pwsh?: BundledPwsh | undefined
  /** Bundled CPython directory, when the package carries one. */
  readonly pythonDirectory?: string | undefined
  /** Directory holding bundled Hub plugin archives. */
  readonly hubPluginsDirectory?: string | undefined
}

/** Inputs that do not depend on the running machine. */
export interface HubRuntimeLayoutOptions {
  /** Whether the shell runs from an installed package. */
  readonly packaged: boolean
  /** `process.resourcesPath` of the running application. */
  readonly resourcesPath: string
  /** `app.getAppPath()`, used to find build outputs in an unpackaged launch. */
  readonly appPath: string
}

/**
 * Resolve the bundled runtime directories of this build.
 * @param options - Packaging state and the two Electron path roots.
 * @returns Existing directories only; a development tree without outputs reports none.
 */
export function resolveHubRuntimeLayout(options: HubRuntimeLayoutOptions): HubRuntimeLayout {
  const runtime = options.packaged
    ? join(options.resourcesPath, 'runtime')
    : join(options.appPath, '.desktop-build', 'targets', 'win-x64', 'runtime')
  const pwshRoot = join(runtime, BUNDLED_PWSH_DIRECTORY)
  let pwsh: BundledPwsh | undefined
  if (existsSync(join(pwshRoot, BUNDLED_PWSH_MANIFEST))) {
    try {
      const manifest = readPwshRuntimeManifest(pwshRoot)
      const directory = join(pwshRoot, manifest.directory)
      if (existsSync(join(directory, 'pwsh.exe'))) pwsh = { directory, version: manifest.version, sha256: manifest.sha256 }
    } catch {
      // A descriptor that cannot be read leaves the upstream PowerShell resolution in place;
      // selection falls back to 5.1 exactly as it does when the bundle is absent.
      pwsh = undefined
    }
  }
  const pythonDirectory = join(runtime, 'primary-runtime', 'dependencies', 'python')
  const hubPluginsDirectory = join(runtime, 'hub-plugins')
  return {
    ...pwsh === undefined ? {} : { pwsh },
    ...existsSync(join(pythonDirectory, 'python.exe')) ? { pythonDirectory } : {},
    ...existsSync(hubPluginsDirectory) ? { hubPluginsDirectory } : {},
  }
}

/**
 * Read the bundled PowerShell descriptor.
 * @param root - `runtime/pwsh` directory of the build.
 * @returns Validated descriptor.
 * @throws {Error} When the descriptor is missing, malformed, or not an object.
 */
export function readPwshRuntimeManifest(root: string): PwshRuntimeManifest {
  const value: unknown = JSON.parse(readFileSync(join(root, BUNDLED_PWSH_MANIFEST), 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop runtime: pwsh runtime.json must be an object')
  }
  const record = value as Record<string, unknown>
  const version = record.version
  const directory = record.directory
  const sha256 = record.sha256
  if (typeof version !== 'string' || version === '' || typeof directory !== 'string' || directory === ''
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error('desktop runtime: pwsh runtime.json must name a version, directory, and SHA-256')
  }
  return { version, sha256, directory }
}

/** Outcome of the bundled PowerShell self-check. */
export interface PwshSelfCheck {
  /** Whether the executable reported the expected version. */
  readonly ok: boolean
  /** Evidence line for the startup log and the crash report. */
  readonly detail: string
}

/**
 * Run the bundled PowerShell once and compare the version it reports.
 * A failure is a diagnostic, not a startup error: the caller keeps the upstream
 * resolution chain, which ends at Windows PowerShell 5.1.
 * @param executable - Absolute `pwsh.exe` path.
 * @param expectedVersion - Version the packaged descriptor declares.
 * @param timeoutMs - Deadline for the probe.
 * @returns Whether the executable answered with the expected version.
 */
export async function verifyBundledPwsh(executable: string, expectedVersion: string, timeoutMs = 15_000): Promise<PwshSelfCheck> {
  return await new Promise<PwshSelfCheck>((resolve) => {
    let settled = false
    const finish = (result: PwshSelfCheck): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, detail: `bundled PowerShell did not answer within ${String(timeoutMs)} ms` })
    }, timeoutMs)
    timer.unref()
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => { finish({ ok: false, detail: `bundled PowerShell could not start: ${error.message}` }) })
    child.once('close', (code) => {
      const reported = stdout.trim()
      if (code === 0 && reported === expectedVersion) {
        finish({ ok: true, detail: `bundled PowerShell ${reported} answered its self-check` })
        return
      }
      const stderrTail = stderr.trim().slice(0, 200)
      finish({ ok: false, detail: `bundled PowerShell reported ${JSON.stringify(reported)} (exit ${String(code)})${stderrTail === '' ? '' : `: ${stderrTail}`}` })
    })
  })
}

/** Everything the Host environment composition needs. */
export interface HubHostEnvironmentOptions {
  /** Environment inherited from the launcher (login shell on macOS, process environment elsewhere). */
  readonly base: NodeJS.ProcessEnv
  /** Target platform of the running application. */
  readonly platform: NodeJS.Platform
  /** Bundled runtime directories; absent entries contribute nothing. */
  readonly layout: HubRuntimeLayout
  /** Whether the bundled PowerShell self-check passed. */
  readonly pwshVerified: boolean
  /** Whether the bundled Python runs in UTF-8 mode. */
  readonly pythonUtf8: boolean
  /** System proxy already decoded from the operating system, when one was found. */
  readonly proxy?: ProxyEnvironment | undefined
  /** Proxy policy a Hub manifest delivered in the overlay; it outranks the system proxy. */
  readonly proxyOverride?: HubProxyOverride | undefined
  /** Whether the user's own pip configuration exists (existence only; its contents are never read). */
  readonly pipConfigPresent: boolean
}

/** Composed environment plus the facts worth reporting at startup. */
export interface HubHostEnvironmentResult {
  /** Environment for the Host and every child process it starts. */
  readonly environment: NodeJS.ProcessEnv
  /** Startup diagnostics, in the order they were produced. */
  readonly diagnostics: readonly string[]
}

/** Return the first non-empty value of an environment key, treating blank values as unset. */
function configured(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]
  return value === undefined || value.trim() === '' ? undefined : value
}

/**
 * Compose the Host environment for this build and machine.
 *
 * Precedence, highest first: the user's own environment, this build's runtime
 * values, the operating-system proxy, and the process defaults. A configured
 * value is never overwritten, so a user can pin a different interpreter,
 * mirror, or proxy without editing the install.
 * @param options - Inherited environment, bundled layout, and resolved machine facts.
 * @returns The composed environment and the diagnostics that explain it.
 */
export function composeHubHostEnvironment(options: HubHostEnvironmentOptions): HubHostEnvironmentResult {
  const environment: NodeJS.ProcessEnv = { ...options.base }
  const diagnostics: string[] = []
  const windows = options.platform === 'win32'

  if (windows) {
    if (options.pwshVerified && options.layout.pwsh !== undefined) {
      environment.DSH_PWSH_PATH = join(options.layout.pwsh.directory, 'pwsh.exe')
      // Privacy boundary: the bundled engine must not report telemetry or check for updates.
      Object.assign(environment, TELEMETRY_OPTOUT)
      // The agent shell renders plain text; ANSI escapes only waste model context.
      environment.NO_COLOR ??= '1'
      diagnostics.push(`desktop runtime: bundled PowerShell ${options.layout.pwsh.version} at ${environment.DSH_PWSH_PATH}`)
    } else if (options.layout.pwsh !== undefined) {
      diagnostics.push('desktop runtime: bundled PowerShell failed its self-check; keeping the upstream resolution chain (Windows PowerShell 5.1)')
    }
    const python = options.layout.pythonDirectory
    if (python !== undefined) {
      const scripts = join(python, 'Scripts')
      const prefix = existsSync(scripts) ? `${python}${delimiter}${scripts}` : python
      environment.PATH = `${prefix}${delimiter}${environment.PATH ?? ''}`
      diagnostics.push(`desktop runtime: bundled Python first on PATH at ${python}`)
      if (options.pythonUtf8) {
        // UTF-8 mode also changes `open()`'s default encoding; the settings toggle exists for that.
        environment.PYTHONUTF8 ??= '1'
        environment.PYTHONIOENCODING ??= 'utf-8'
      } else {
        diagnostics.push('desktop runtime: Python UTF-8 mode is disabled by local settings')
      }
      if (options.pipConfigPresent) {
        diagnostics.push('desktop runtime: the user has a pip configuration; injecting no package index')
      } else if (configured(environment, 'PIP_INDEX_URL') === undefined) {
        environment.PIP_INDEX_URL = DEFAULT_PIP_INDEX_URL
        environment.PIP_TRUSTED_HOST ??= DEFAULT_PIP_TRUSTED_HOST
      }
    }
  }

  // The Host's connector installs the bundled plugins and reads the bundled model
  // snapshot from this directory (design §4.2, §4.3); a user value still wins.
  const hubPlugins = options.layout.hubPluginsDirectory
  if (hubPlugins !== undefined) {
    environment.DSH_HUB_BUNDLED_DIR ??= hubPlugins
    diagnostics.push(`desktop runtime: bundled Hub plugins at ${hubPlugins}`)
  }

  const proxy = options.proxy
  const override: HubProxyOverride | undefined = options.proxyOverride
  if (proxy !== undefined || override !== undefined) {
    const existing = userProxyVariable(environment)
    if (existing !== undefined) {
      diagnostics.push(`desktop proxy: ${existing} is already set; keeping the configured proxy`)
    } else {
      // A Hub policy outranks the machine's own configuration; the per-field merge keeps
      // a delivered bypass list applicable to a machine-configured proxy.
      const hubSuppliesEndpoints = override?.http !== undefined || override?.https !== undefined
      const http = override?.http ?? proxy?.httpProxy
      const https = override?.https ?? proxy?.httpsProxy
      const noProxy = override?.noProxy ?? proxy?.noProxy
      const source = hubSuppliesEndpoints ? 'the Hub overlay' : 'the Windows system proxy'
      // Both spellings: the Harness reads lowercase first, while Windows tools and
      // Python's own clients read the uppercase form.
      if (http !== undefined) { environment.http_proxy = http; environment.HTTP_PROXY = http }
      if (https !== undefined) { environment.https_proxy = https; environment.HTTPS_PROXY = https }
      if (noProxy !== undefined) { environment.no_proxy = noProxy; environment.NO_PROXY = noProxy }
      diagnostics.push(`desktop proxy: ${https ?? http ?? 'direct'} from ${source}`)
    }
    diagnostics.push(...proxy?.diagnostics ?? [])
  }
  return { environment, diagnostics }
}

/** Inputs the shell gathers from the machine before composing the environment. */
export interface HubSystemFacts {
  /** Decoded Windows proxy configuration, when the system has one. */
  readonly proxy?: WindowsSystemProxy | undefined
  /** Result of resolving an auto-configuration URL for this client, when a PAC applies. */
  readonly resolvedProxy?: { readonly http?: string | undefined; readonly https?: string | undefined } | undefined
  /** Whether `%APPDATA%\pip\pip.ini` or `%USERPROFILE%\pip\pip.ini` exists. */
  readonly pipConfigPresent: boolean
}

/**
 * Compose the proxy environment from decoded Windows facts.
 * @param facts - Proxy configuration and, when a PAC applies, the resolved endpoints.
 *   An answer without endpoints means the resolver chose direct access.
 * @returns Proxy variables to inject, or an empty result when the system configures none.
 */
export function hubProxyEnvironment(facts: HubSystemFacts): ProxyEnvironment {
  if (facts.proxy === undefined) return { diagnostics: [] }
  return composeProxyEnvironment(facts.proxy, facts.resolvedProxy)
}

/** Model endpoint a PAC is probed with when the build configures no Hub origin. */
export const MODEL_API_ORIGIN = 'https://api.deepseek.com'

/**
 * Choose the origin an auto-configuration script is resolved for.
 * A PAC may answer per host; the Harness routes the Hub and the model endpoint, so the
 * probe uses the Hub when the build has one and the model endpoint otherwise.
 * @param hubOrigin - Hub origin from the branding configuration, empty when disabled.
 * @returns Absolute origin to resolve.
 */
export function proxyProbeOrigin(hubOrigin: string): string {
  return hubOrigin === '' ? `${MODEL_API_ORIGIN}/` : `${hubOrigin}/`
}

/**
 * Report whether the user's own pip configuration exists.
 * Only existence is checked: the file may contain credentials, and it belongs to the user.
 * @param environment - Environment that names `%APPDATA%` and `%USERPROFILE%`.
 * @returns Whether either documented pip configuration file exists.
 */
export function pipConfigurationPresent(environment: NodeJS.ProcessEnv): boolean {
  const roaming = configured(environment, 'APPDATA')
  const profile = configured(environment, 'USERPROFILE')
  for (const root of [roaming, profile]) {
    if (root === undefined) continue
    try {
      if (statSync(join(root, 'pip', 'pip.ini')).isFile()) return true
    } catch {
      // A missing or unreadable candidate is not a configuration this build must respect.
    }
  }
  return false
}
