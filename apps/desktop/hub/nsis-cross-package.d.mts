/** Types for the Windows-only inputs of an NSIS installer built on another host. */

/** Environment flag that marks installer interface assets a Windows host already compiled. */
export const INSTALLER_UI_ENV: string

/**
 * Resolve the installer interface directory `installer.nsh` defaults to.
 * @param buildRoot Target build directory (`desktopTargetBuildPaths().root`).
 * @returns Directory holding the compiled setup assets.
 */
export function installerUiDirectory(buildRoot: string): string

/**
 * Reject an installer build whose setup assets a Windows host has not produced.
 * @param directory Directory the installer script embeds its assets from.
 * @returns Nothing; throws when any asset is missing.
 */
export function verifyInstallerUi(directory: string): void

/**
 * Resolve the 7-Zip executable the installer embeds for the target machine.
 * @returns Windows `7za.exe` on any host but Windows, the host tool otherwise.
 */
export function payloadSevenZipPath(): Promise<string>

/**
 * Generate the uninstaller without Wine by reading it out of the generation installer.
 * @returns Nothing.
 */
export function installUninstallerExtraction(): void
