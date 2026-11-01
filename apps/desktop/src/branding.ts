/**
 * Desktop shell branding constants inlined by the build from `hub/branding.mjs`.
 *
 * `hub/branding.mjs` owns the values and `tsdown.config.ts` replaces the
 * `DSH_HUB_BRANDING` identifier below with them, so this module holds no brand
 * values of its own. Tooling that runs these sources directly (tsx scripts, the
 * development launcher) sees no such identifier and keeps the upstream names.
 */

/** Branding record the bundle inlines from `hub/branding.mjs`. */
declare const DSH_HUB_BRANDING: {
  readonly productName: string
  readonly userDataDirectoryName: string
  readonly hubOrigin: string
  readonly iconPng: string
  readonly telemetry: 'off' | 'upstream'
} | undefined

/** Inlined branding, or undefined when these sources run without the bundle step. */
const inlined = typeof DSH_HUB_BRANDING === 'undefined' ? undefined : DSH_HUB_BRANDING

/** Product identity and network policy this build was created with. */
export const DESKTOP_BRANDING = Object.freeze({
  /** Name shown by the about panel, menus, window titles, and installer. */
  productName: inlined?.productName ?? 'DeepSeek Harness',
  /** Electron userData directory name, which follows app.name. */
  userDataDirectoryName: inlined?.userDataDirectoryName ?? '@deepseek-ai/dsh-desktop',
  /** Hub origin this build talks to; empty disables every Hub endpoint. */
  hubOrigin: inlined?.hubOrigin ?? '',
  /** Application icon, relative to `app.getAppPath()` in an unpackaged launch. */
  iconPng: inlined?.iconPng ?? 'resources/icon-windows.png',
  /** Name the shipped dictionaries use for the product. */
  upstreamProductName: 'DeepSeek Harness',
  /** Whether the Host runs with the shared telemetry opt-out set. */
  telemetryDisabled: inlined?.telemetry === 'off',
})

/** Process environment shape this module reads and returns. */
type Environment = Readonly<Record<string, string | undefined>>

/**
 * Replace the upstream product name in shell copy.
 * @param messages - Localized shell dictionary.
 * @returns The same keys with the branded product name.
 */
export function brandDesktopMessages<T extends Readonly<Record<string, string>>>(messages: T): T {
  const branded: Record<string, string> = {}
  for (const [key, value] of Object.entries(messages)) {
    branded[key] = value.replaceAll(DESKTOP_BRANDING.upstreamProductName, DESKTOP_BRANDING.productName)
  }
  return branded as T
}

/**
 * Add this build's telemetry policy to the Host environment.
 * @param environment - Shell environment inherited by the Host.
 * @returns Environment with the opt-out applied when the build disables telemetry.
 */
export function brandedHostEnvironment(environment: Environment = process.env): Record<string, string | undefined> {
  return DESKTOP_BRANDING.telemetryDisabled ? { ...environment, DSH_TELEMETRY_DISABLED: '1' } : { ...environment }
}
