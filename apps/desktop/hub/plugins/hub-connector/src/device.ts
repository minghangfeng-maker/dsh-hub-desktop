/**
 * What this machine tells the Hub about itself.
 *
 * Two documents leave this module and both are closed: the login-time device
 * description (`DesktopAuthDeviceSchema`) and the per-report descriptor. The
 * Hub validates them with `z.strictObject`, so an extra member is a 400 rather
 * than a silently dropped field — the allowlist in the Hub contract is the only
 * privacy boundary, and this module is its single client-side producer.
 * Nothing here may carry a path, a user name, a host name, an environment
 * value, or a hardware identifier.
 */

import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { arch, homedir, platform, release } from 'node:os'
import type { HubState } from './state.ts'

/** `appChannel` values the Hub accepts (the upstream channel names). */
export type AppChannel = 'nightly' | 'latest'

/** Capability booleans the Hub stores verbatim (D4/D5 use them to pick defaults). */
export interface Capabilities {
  readonly claudeCode: boolean
  readonly codex: boolean
  readonly pwsh: '7' | '5.1' | 'none'
}

/** Login-time device description; the Hub's `DesktopAuthDeviceSchema` minus optional members. */
export interface DeviceDescription {
  readonly schemaVersion: 1
  readonly installId: string
  readonly name: string
  readonly platform: 'win32' | 'darwin' | 'linux'
  readonly osMajor: string
  readonly arch: 'x64' | 'arm64' | 'other'
  readonly appVersion: string
  readonly appChannel: AppChannel
  readonly runtimeVersion: string | null
  readonly capabilities: Capabilities
}

/** What this build knows about the running application, resolved once at load. */
export interface BuildIdentity {
  /** Release version of the Host package; the Hub requires `1.2.3` form. */
  readonly appVersion: string
  /** Release channel the installer baked in. */
  readonly appChannel: AppChannel
  /** Bundled runtime version; today the Host release version. */
  readonly runtimeVersion: string | null
  /** Build-time Hub origin the installer recorded, empty when the build baked none. */
  readonly builtHubOrigin: string
  /** Human platform label, used for the default device name. */
  readonly osLabel: string
  /** Per-install identifier the Hub hashes into its install key (a UUIDv4). */
  readonly installId: string
  /** Directory holding this package's `manifest.schema.json`. */
  readonly schemaDirectory: string
}

/** Fallback version for a source checkout that carries no release metadata. */
const FALLBACK_VERSION = '0.0.1'

/**
 * Read the release version from the Host package manifest the profile launcher anchored on.
 * @param installAnchor - Absolute path of the running `@deepseek-ai/dsh` package.json.
 * @returns A semantic version, or a readable fallback when the manifest is absent or malformed.
 */
export function readAppVersion(installAnchor: string | undefined): string {
  if (installAnchor === undefined) return FALLBACK_VERSION
  try {
    const value: unknown = JSON.parse(readFileSync(installAnchor, 'utf8'))
    if (typeof value !== 'object' || value === null) return FALLBACK_VERSION
    const version = (value as { version?: unknown }).version
    return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
      ? version
      : FALLBACK_VERSION
  } catch {
    return FALLBACK_VERSION
  }
}

/**
 * Reduce an operating-system release to the major version the Hub stores.
 * @param name - `process.platform` value.
 * @param kernelRelease - `os.release()`; Windows reports the NT build, macOS the Darwin kernel.
 * @returns A digits-and-dots string of at most eight characters.
 */
export function osMajor(name: string, kernelRelease: string): string {
  if (name === 'win32') {
    const build = Number(kernelRelease.split('.')[2] ?? '')
    // Windows 10 and 11 share the NT 10.0 prefix; the build number is the only discriminator.
    if (Number.isFinite(build)) return build >= 22_000 ? '11' : '10'
    return '10'
  }
  if (name === 'darwin') {
    const kernel = Number(kernelRelease.split('.')[0] ?? '')
    // Darwin 20 == macOS 11 (Big Sur); the offset has held for every release since.
    return Number.isFinite(kernel) && kernel >= 20 ? String(kernel - 9) : '0'
  }
  const numeric = /^[0-9]+(?:\.[0-9]+)*/u.exec(kernelRelease)?.[0] ?? '0'
  return numeric.slice(0, 8)
}

/**
 * Human label for the platform, used in the default device name and the account page.
 * @param name - `process.platform` value.
 * @param major - Result of {@link osMajor}.
 * @returns `Windows 11`, `macOS 15`, or `Linux`.
 */
export function osLabel(name: string, major: string): string {
  if (name === 'win32') return `Windows ${major}`
  if (name === 'darwin') return `macOS ${major}`
  return 'Linux'
}

/**
 * Map `process.arch` onto the Hub's three-value contract.
 * @param value - `process.arch` value.
 * @returns `x64`, `arm64`, or `other`.
 */
export function hubArch(value: string): 'x64' | 'arm64' | 'other' {
  if (value === 'x64' || value === 'arm64') return value
  return 'other'
}

/**
 * Map `process.platform` onto the Hub's three-value contract.
 * @param value - `process.platform` value.
 * @returns The Hub platform name; other platforms report as `linux` so a report still validates.
 */
export function hubPlatform(value: string): 'win32' | 'darwin' | 'linux' {
  if (value === 'win32' || value === 'darwin') return value
  return 'linux'
}

/**
 * Probe for a pilot program the way the plugins themselves locate it.
 * @param names - Executable base names to look for (`claude`, `codex`).
 * @param environment - Process environment, for `PATH` and a plugin-supplied override.
 * @returns Whether a matching executable is reachable.
 */
export function findsProgram(names: readonly string[], environment: NodeJS.ProcessEnv): boolean {
  const extensions = (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(part => part !== '')
  const directories = (environment.PATH ?? environment.Path ?? '').split(delimiter).filter(part => part !== '')
  const candidates: string[] = []
  for (const name of names) {
    candidates.push(join(homedir(), '.local', 'bin', name))
    for (const directory of directories) {
      candidates.push(join(directory, name))
      for (const extension of extensions) candidates.push(join(directory, `${name}${extension.toLowerCase()}`))
    }
  }
  return candidates.some(candidate => existsSync(candidate))
}

/**
 * Detect what this machine can run, for the Hub's capability columns.
 * @param environment - Process environment the Host launched with.
 * @returns The three capability facts; all of them are booleans or fixed enums.
 */
export function capabilitiesOf(environment: NodeJS.ProcessEnv): Capabilities {
  const claudeCode = findsProgram(['claude'], environment)
  const codex = findsProgram(['codex'], environment)
  const pwsh: Capabilities['pwsh'] = (environment.DSH_PWSH_PATH ?? '') !== ''
    ? '7'
    : platform() === 'win32' ? '5.1' : 'none'
  return { claudeCode, codex, pwsh }
}

/**
 * Build the login-time device description.
 * @param options - Resolved build identity, current state, and process environment.
 * @returns A description that satisfies the Hub's strict object.
 */
export function describeDevice(options: {
  readonly build: BuildIdentity
  readonly state: HubState
  readonly environment: NodeJS.ProcessEnv
}): DeviceDescription {
  const major = osMajor(platform(), release())
  return {
    schemaVersion: 1,
    installId: options.state.installId,
    name: options.state.settings.deviceName,
    platform: hubPlatform(platform()),
    osMajor: major,
    arch: hubArch(arch()),
    appVersion: options.build.appVersion,
    appChannel: options.build.appChannel,
    runtimeVersion: options.build.runtimeVersion,
    capabilities: capabilitiesOf(options.environment),
  }
}
