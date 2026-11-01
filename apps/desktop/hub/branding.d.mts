/** Types for the DSH Hub desktop identity and outbound-service policy. */

/** Product identity, icons, and network policy of one desktop build. */
export interface DesktopBranding {
  /** Installer, executable, about panel, menus, and window titles show this name. */
  readonly productName: string
  /** Windows version-resource CompanyName and the installer's publisher line. */
  readonly companyName: string
  /** Legal copyright written into the executable, the installer, and the bundle metadata. */
  readonly copyright: string
  /** Reverse-DNS application identifier registered by the Windows installer. */
  readonly appId: string
  /** Electron userData directory under the user's application-data directory. */
  readonly userDataDirectoryName: string
  /** Name the operating system registers for the `dsh://` URL scheme. */
  readonly protocolName: string
  /** Application icon for the about panel and the packaged `icon.png`, relative to apps/desktop. */
  readonly iconPng: string
  /** Windows application icon: the multi-size ICO electron-builder embeds in the executable. */
  readonly iconIco: string
  /** Windows tray bitmap with one bitmap per display scale, relative to apps/desktop. */
  readonly trayIcon: string
  /** Upstream product name replaced in shell copy. */
  readonly upstreamProductName: string
  /** Hub HTTPS origin used by the shipped feed, policy, and proxy defaults. */
  readonly hubOrigin: string
  /** `off` emits no update feed; `hub` publishes a generic feed under the Hub origin. */
  readonly updateFeed: 'off' | 'upstream' | 'hub'
  /** `off` embeds no mandatory-update origin; `hub` points the policy at the Hub origin. */
  readonly mandatoryUpdatePolicy: 'off' | 'upstream' | 'hub'
  /** `off` disables the Host's session and product telemetry exports. */
  readonly telemetry: 'off' | 'upstream'
}

/** Product identity, icons, and network policy of this build. */
export declare const DESKTOP_BRANDING: Readonly<DesktopBranding>

/**
 * Resolve the application identifier the packaging scripts validate.
 * @param environment - Packaging environment.
 * @returns Reverse-DNS identifier.
 */
export declare function brandedAppId(environment?: NodeJS.ProcessEnv): string

/**
 * Resolve the Hub origin this build talks to.
 * @param environment - Packaging environment.
 * @returns HTTPS origin without a trailing slash, or `''` when the Hub is disabled.
 */
export declare function brandedHubOrigin(environment?: NodeJS.ProcessEnv): string

/**
 * Resolve the generic update feed the shipped updater polls.
 * @param hubOrigin - HTTPS origin from {@link brandedHubOrigin}.
 * @param target - Release target directory name.
 * @returns Feed URL ending in a slash.
 */
export declare function hubFeedUrl(hubOrigin: string, target: string): string

/**
 * Resolve the mandatory-update policy metadata a Hub build embeds.
 * @param hubOrigin - HTTPS origin from {@link brandedHubOrigin}.
 * @returns Policy metadata.
 */
export declare function hubPolicy(hubOrigin: string): { origin: string; allowedPageOrigins: string[]; authentication: 'anonymous' }

/**
 * Resolve one brand asset path next to the branding module.
 * @param relativePath - Asset path declared in {@link DESKTOP_BRANDING}, relative to apps/desktop.
 * @returns Absolute filesystem path.
 */
export declare function brandedAssetPath(relativePath: string): string
