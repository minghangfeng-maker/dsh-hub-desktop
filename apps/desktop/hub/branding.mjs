/**
 * DSH Hub desktop identity and outbound-service policy.
 *
 * This module is the single branding source for a Hub build: the packaging
 * configuration, the Electron shell, and the generated icons read it, so a
 * rebase onto upstream only has to keep the import sites instead of the values.
 * Upstream's own values are left untouched wherever this module is not imported.
 */

import { fileURLToPath } from 'node:url'

/**
 * Product identity, icons, and network policy of this build.
 * @type {{
 *   productName: string,
 *   companyName: string,
 *   copyright: string,
 *   appId: string,
 *   userDataDirectoryName: string,
 *   protocolName: string,
 *   iconPng: string,
 *   iconIco: string,
 *   trayIcon: string,
 *   upstreamProductName: string,
 *   hubOrigin: string,
 *   updateFeed: 'off' | 'upstream' | 'hub',
 *   mandatoryUpdatePolicy: 'off' | 'upstream' | 'hub',
 *   telemetry: 'off' | 'upstream',
 * }}
 */
export const DESKTOP_BRANDING = Object.freeze({
  /** Installer, executable, about panel, menus, and window titles show this name. */
  productName: 'DSH Hub',
  /** Windows version-resource CompanyName and the installer's publisher line. */
  companyName: 'DSH Hub',
  /** Legal copyright written into the executable, the installer, and the bundle metadata. */
  copyright: 'Copyright © 2026 DSH Hub',
  /** Reverse-DNS application identifier registered by the Windows installer. */
  appId: 'tech.dshhub.desktop',
  /** Electron userData directory under the user's application-data directory. */
  userDataDirectoryName: 'DSH Hub',
  /** Name the operating system registers for the `dsh://` URL scheme. */
  protocolName: 'DSH Hub',
  /** Application icon for the about panel and the packaged `icon.png`, resolved relative to apps/desktop. */
  iconPng: 'hub/icon-windows.png',
  /** Windows application icon: the multi-size ICO electron-builder embeds in the executable. */
  iconIco: 'hub/icon-windows.ico',
  /** Windows tray bitmap with one bitmap per display scale, resolved relative to apps/desktop. */
  trayIcon: 'hub/tray-windows.ico',
  /** Upstream product name replaced in shell copy. */
  upstreamProductName: 'DeepSeek Harness',
  /**
   * Hub HTTPS origin used by the shipped feed, policy, and proxy defaults.
   * Empty disables every Hub endpoint, which is the local and unsigned default.
   */
  hubOrigin: '',
  /** `off` emits no update feed; `hub` publishes a generic feed under `hubOrigin`. */
  updateFeed: 'off',
  /** `off` embeds no mandatory-update origin; `hub` points the policy at `hubOrigin`. */
  mandatoryUpdatePolicy: 'off',
  /** `off` disables the Host's session and product telemetry exports. */
  telemetry: 'off',
})

/**
 * Resolve the application identifier the packaging scripts validate.
 * @param {NodeJS.ProcessEnv} environment - Packaging environment.
 * @returns {string} Reverse-DNS identifier; branding unless the environment overrides it.
 */
export function brandedAppId(environment = process.env) {
  const configured = environment.DSH_DESKTOP_APP_ID?.trim() ?? ''
  return configured === '' ? DESKTOP_BRANDING.appId : configured
}

/**
 * Resolve the Hub origin this build talks to.
 * @param {NodeJS.ProcessEnv} environment - Packaging environment.
 * @returns {string} HTTPS origin without a trailing slash, or `''` when the Hub is disabled.
 * @throws {Error} When the configured value is not an absolute HTTPS origin.
 */
export function brandedHubOrigin(environment = process.env) {
  const configured = environment.DSH_HUB_ORIGIN?.trim()
  const value = configured === undefined || configured === '' ? DESKTOP_BRANDING.hubOrigin : configured
  if (value === '') return ''
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('hub branding: DSH_HUB_ORIGIN must be an absolute HTTPS origin') }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''
    || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('hub branding: DSH_HUB_ORIGIN must be an absolute HTTPS origin without a path, credentials, query, or fragment')
  }
  return parsed.origin
}

/**
 * Resolve the generic update feed the shipped updater polls.
 * `electron-updater` resolves `<url><channel>.yml` beside the target directory, so the
 * feed keeps the per-target layout of `D3` §7.2 under the Hub origin.
 * @param {string} hubOrigin - HTTPS origin from {@link brandedHubOrigin}.
 * @param {string} target - Release target directory name (`win-x64`, `mac-arm64`, `mac-x64`).
 * @returns {string} Feed URL ending in a slash, as the generic provider requires.
 */
export function hubFeedUrl(hubOrigin, target) {
  if (hubOrigin === '') throw new Error('hub branding: a Hub feed requires a Hub origin')
  return `${hubOrigin}/desktop/feeds/${target}/`
}

/**
 * Resolve the mandatory-update policy metadata a Hub build embeds.
 * The anonymous deployment has no extra page origins: the policy answers the same
 * `check_client_update` contract from the Hub origin, so that origin is its only page.
 * @param {string} hubOrigin - HTTPS origin from {@link brandedHubOrigin}.
 * @returns {{ origin: string, allowedPageOrigins: string[], authentication: 'anonymous' }} Policy metadata.
 */
export function hubPolicy(hubOrigin) {
  if (hubOrigin === '') throw new Error('hub branding: a Hub policy requires a Hub origin')
  return { origin: hubOrigin, allowedPageOrigins: [hubOrigin], authentication: 'anonymous' }
}

/**
 * Resolve one placeholder asset next to this module.
 * @param {string} relativePath - Asset path declared in `DESKTOP_BRANDING`, relative to apps/desktop.
 * @returns {string} Absolute filesystem path the packaging configuration accepts.
 */
export function brandedAssetPath(relativePath) {
  return fileURLToPath(new URL(`../${relativePath}`, import.meta.url))
}
