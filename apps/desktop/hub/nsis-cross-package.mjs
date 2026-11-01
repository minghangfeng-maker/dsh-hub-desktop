/**
 * Supply the Windows-only inputs of an NSIS installer that is built on another host.
 *
 * electron-builder already assembles a Windows installer off Windows: it packs the
 * payload with the host 7-Zip, compiles the pinned NSIS script, and signs nothing.
 * Three inputs still come from Windows, and a Hub build supplies them here:
 *
 * - The installer interface (`window-frame.dll` plus the setup bitmaps) is native
 *   code compiled by MSVC and rendered by GDI+. `hub-build.sh --installer` runs
 *   `build-installer-windows.ps1` on the Windows host first and sets
 *   `DSH_HUB_INSTALLER_UI=1`, which tells the packaging configuration that those
 *   assets already exist and must not be compiled again.
 * - The 7-Zip executable embedded in the installer extracts the payload on the
 *   target machine, so it is the Windows build rather than the host's.
 * - Generating the uninstaller normally runs the uninstaller-generation installer
 *   under Wine. Its bytes are also produced in-process by the NSIS reader
 *   electron-builder already uses on macOS Catalina, which removes Wine from the
 *   build entirely.
 *
 * Nothing here runs on a Windows host: there the upstream steps are already native.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** Environment flag that marks installer interface assets prepared by a Windows host. */
export const INSTALLER_UI_ENV = 'DSH_HUB_INSTALLER_UI'

/** Assets `installer.nsh` embeds; a Windows host produces all of them. */
const INSTALLER_UI_ASSETS = [
  'brand.bmp',
  'brand-2x.bmp',
  'brand-dark.bmp',
  'brand-dark-2x.bmp',
  'uninstaller-sidebar.bmp',
  'window-frame.dll',
]

/**
 * SHA-256 of the Windows 7-Zip toolset, copied from the table `app-builder-lib`
 * verifies its own download against (`toolsets/7zip.js`); a unit test pins it.
 */
const WINDOWS_7ZIP_FILENAME = '7zip-win-x64.tar.gz'
const WINDOWS_7ZIP_CHECKSUM = 'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3'

const patched = Symbol.for('@deepseek-ai/dsh-desktop/hub-nsis-cross-package')

/**
 * Resolve the installer interface directory `installer.nsh` defaults to.
 * @param {string} buildRoot - Target build directory (`desktopTargetBuildPaths().root`).
 * @returns {string} Directory holding the compiled setup assets.
 */
export function installerUiDirectory(buildRoot) {
  return join(buildRoot, 'installer-ui')
}

/**
 * Reject an installer build whose setup assets a Windows host has not produced.
 * @param {string} directory - Directory the installer script embeds its assets from.
 * @throws {Error} When any asset is missing, naming every missing file.
 */
export function verifyInstallerUi(directory) {
  const missing = INSTALLER_UI_ASSETS.filter(asset => !existsSync(join(directory, asset)))
  if (missing.length !== 0) {
    throw new Error(`desktop package: ${INSTALLER_UI_ENV} names ${directory}, which is missing ${missing.join(', ')}; `
      + 'run hub-build.sh --installer, which compiles them on the Windows host')
  }
}

/**
 * Resolve the 7-Zip executable the installer embeds for the target machine.
 * @returns {Promise<string>} Windows `7za.exe` on any host but Windows, the host tool otherwise.
 */
export async function payloadSevenZipPath() {
  const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
  if (process.platform === 'win32') return getPath7za()
  const { downloadBuilderToolset } = require('app-builder-lib/out/util/electronGet.js')
  const toolset = await downloadBuilderToolset({
    releaseName: '7zip@1.0.0',
    filenameWithExt: WINDOWS_7ZIP_FILENAME,
    checksums: { [WINDOWS_7ZIP_FILENAME]: WINDOWS_7ZIP_CHECKSUM },
  })
  return join(toolset, 'bin', '7za.exe')
}

/**
 * Generate the uninstaller without Wine by reading it out of the generation installer.
 *
 * electron-builder runs the uninstaller-generation installer through Wine so that
 * NSIS writes the uninstaller beside it. The same bytes are the generation
 * installer's executable image followed by the NSIS block it wrote, which the
 * pinned NSIS reader reconstructs; upstream already takes that path on macOS
 * Catalina for the same reason.
 * @returns {void}
 */
export function installUninstallerExtraction() {
  require('app-builder-lib')
  const { WineVmManager } = require('app-builder-lib/out/vm/WineVm.js')
  const { UninstallerReader } = require('app-builder-lib/out/targets/nsis/nsisUtil.js')
  const prototype = WineVmManager.prototype
  if (prototype[patched]) return
  prototype[patched] = true
  const exec = prototype.exec
  prototype.exec = async function (file, ...args) {
    if (process.platform === 'win32') return exec.call(this, file, ...args)
    // NSIS names the generated uninstaller after the installer it came from.
    await UninstallerReader.exec(file, join(dirname(file), `${basename(file, 'exe')}__uninstaller.exe`))
  }
}
