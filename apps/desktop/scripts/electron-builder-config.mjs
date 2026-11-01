import { officePackageDirectories } from '../../../scripts/libreoffice-packages.mjs'
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  resolveDesktopAppId,
  resolveMacOSNotarizationEnvironment,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import { notarizeMacOSDiskImageArtifact } from './notarize-macos-disk-images.mjs'
import { verifyMacOSDiskImageSignature, verifyMacOSSignatureAfterSign } from './verify-macos-signature.mjs'
import {
  createWindowsTokenSigner,
  installWindowsNsisBootstrapSigner,
  resolveWindowsUpdatePublisher,
  scrubWindowsSigningEnvironment,
} from './windows-sign.mjs'
import { resolveDesktopAutoUpdateConfig, resolveDesktopAutoUpdateTarget, resolveDesktopUpdateChannel } from './desktop-auto-update-environment.mjs'
import { resolveDesktopBuildCommit } from './desktop-build-commit.mjs'
import { resolveDesktopBuildVersion } from './desktop-build-version.mjs'
import { resolveDesktopPolicyEnvironment } from './desktop-policy-environment.mjs'
import { desktopArtifactOutput, desktopTargetBuildPaths, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'
import { installWindowsDirectoryInstaller } from './windows-directory-installer.mjs'
import { preserveWindowsRuntimeSignature, signWindowsCode } from './windows-runtime-signature.mjs'
import { prepareWindowsAsarUnpack, verifyWindowsAsarUnpack } from './windows-asar-unpack.mjs'
import { recordPackagingEvent } from './packaging-run.mjs'
import { resolveMacOSAppUpdateFeed, verifyMacOSAppUpdateConfig, writeMacOSAppUpdateConfig } from './macos-app-update-config.mjs'
import { DESKTOP_BRANDING, brandedAssetPath, brandedHubOrigin, hubFeedUrl, hubPolicy } from '../hub/branding.mjs'
import { INSTALLER_UI_ENV, installUninstallerExtraction, installerUiDirectory, verifyInstallerUi } from '../hub/nsis-cross-package.mjs'

/**
 * Create electron-builder configuration from one release environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no explicit target is present.
 * @param {string} hostArch - Build-host architecture used when no explicit target is present.
 * @param {string | undefined} preparedRuntime - Verified private dsh tree for installed-update qualification; ordinary releases use the target tree.
 * @param {string | undefined} preparedRuntimeVersion - Version that private tree declares, which qualification rewrites away from the product version.
 * @returns {object} electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
  preparedRuntime = undefined,
  preparedRuntimeVersion = undefined,
) {
  const appId = resolveDesktopAppId(env)
  const targetPlatform = env.DSH_DESKTOP_TARGET_PLATFORM
  const resolvedPlatform = targetPlatform ?? hostPlatform
  const resolvedArch = env.DSH_DESKTOP_TARGET_ARCH ?? hostArch
  if (env.DSH_DESKTOP_UNSIGNED !== undefined && !['0', '1'].includes(env.DSH_DESKTOP_UNSIGNED)) {
    throw new Error('desktop package: DSH_DESKTOP_UNSIGNED must be 0 or 1')
  }
  const unsigned = env.DSH_DESKTOP_UNSIGNED === '1'
  const skipNotarization = env.DSH_DESKTOP_MACOS_SKIP_NOTARIZATION === '1'
  if (env.DSH_DESKTOP_MACOS_SKIP_NOTARIZATION !== undefined && !['0', '1'].includes(env.DSH_DESKTOP_MACOS_SKIP_NOTARIZATION)) {
    throw new Error('desktop package: DSH_DESKTOP_MACOS_SKIP_NOTARIZATION must be 0 or 1')
  }
  if (skipNotarization && (unsigned || resolvedPlatform !== 'darwin')) throw new Error('Skipping notarization requires a signed macOS build')
  const packagesMacOS = targetPlatform === 'darwin' || (targetPlatform === undefined && hostPlatform === 'darwin')
  const packagesWindows = resolvedPlatform === 'win32'
  const hubOrigin = brandedHubOrigin(env)
  // Hub build: branding decides whether this product embeds a mandatory-update origin at all.
  // `hub` points the policy at the Hub; `upstream` keeps the official deployment untouched.
  const policy = packagesMacOS && unsigned ? undefined
    : DESKTOP_BRANDING.mandatoryUpdatePolicy === 'off' ? undefined
      : DESKTOP_BRANDING.mandatoryUpdatePolicy === 'hub' ? hubPolicy(hubOrigin)
        : resolveDesktopPolicyEnvironment(env)
  if (resolvedPlatform === 'win32') installWindowsDirectoryInstaller()
  const macOSSigning = packagesMacOS && !unsigned ? resolveMacOSSigningEnvironment(env) : undefined
  if (packagesMacOS && !unsigned && !skipNotarization) resolveMacOSNotarizationEnvironment(env)
  const buildPaths = desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch))
  const output = desktopArtifactOutput(buildPaths, { unsigned, skipNotarization })
  // Hub build: `hub-build.sh --installer` compiles the NSIS interface on the Windows host first and
  // sets DSH_HUB_INSTALLER_UI=1. This run then embeds those assets, the Windows 7-Zip extractor, and
  // an uninstaller read out of its generation installer instead of running Wine.
  const crossInstaller = packagesWindows && process.platform !== 'win32' && env[INSTALLER_UI_ENV] === '1'
  if (crossInstaller) {
    verifyInstallerUi(installerUiDirectory(buildPaths.root))
    installUninstallerExtraction()
  }
  let primaryRuntimeDestination
  let pwshDestination
  let dshDestination
  let windowsCode = []
  const unpack = ['**/*.{node,dylib,dll,so,exe}', '**/*.so.*', '**/spawn-helper', '**/@vscode/ripgrep-*/bin/rg',
    `**/node_modules/@deepseek-ai/libreoffice-kit-${resolvedPlatform}-${resolvedArch}/**/*`]
  const windowsSigner = packagesWindows && !unsigned
    ? createWindowsTokenSigner({
        certificateFile: env.DSH_DESKTOP_WINDOWS_CER_FILE,
        signTool: env.DSH_DESKTOP_WINDOWS_SIGNTOOL,
        tokenPin: env.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
        keyContainer: env.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
        preserveSignature: async path => {
          // The bundled PowerShell tree is Microsoft-signed and must keep those signatures.
          for (const [sourceRoot, destinationRoot] of [
            [join(buildPaths.runtime, 'primary-runtime'), primaryRuntimeDestination],
            [join(buildPaths.runtime, 'pwsh'), pwshDestination],
            [buildPaths.dsh, dshDestination],
          ]) {
            if (destinationRoot !== undefined && await preserveWindowsRuntimeSignature(path, {
              sourceRoot, destinationRoot, runDirectory: env.DSH_DESKTOP_PACKAGING_RUN_DIR,
            })) return true
          }
          return false
        },
      })
    : undefined
  if (windowsSigner !== undefined) {
    installWindowsNsisBootstrapSigner({ sign: windowsSigner })
  }
  // Hub build: `updateFeed: 'off'` emits no publish feed, so the updater has no upstream origin.
  // `hub` publishes a generic feed under the Hub origin; `upstream` keeps the official deployment.
  const update = unsigned || DESKTOP_BRANDING.updateFeed === 'off' ? undefined
    : DESKTOP_BRANDING.updateFeed === 'hub' ? {
      channel: resolveDesktopUpdateChannel(env),
      origin: hubOrigin,
      publicUrl: hubFeedUrl(hubOrigin, resolveDesktopAutoUpdateTarget(resolvedPlatform, resolvedArch)),
    }
    : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)
  if (preparedRuntime !== undefined) buildPaths.dsh = preparedRuntime
  // electron-builder merges extraMetadata into the packaged manifest, so a build version here reaches
  // the artifact names, the update feed, and the installed app.getVersion() the updater compares against.
  const productVersion = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version
  const buildVersion = resolveDesktopBuildVersion(env, productVersion)
  if (update?.channel === 'latest' && buildVersion.includes('-')) throw new Error('desktop package: latest requires a stable version')
  const packaged = resolveDesktopBuildCommit(env)
  return {
    appId,
    protocols: [{ name: DESKTOP_BRANDING.protocolName, schemes: ['dsh'] }],
    // Installer, executable, and bundle copyright; the hub build names its own company.
    copyright: DESKTOP_BRANDING.copyright,
    extraMetadata: {
      // productName also decides Electron's app.name and therefore the userData directory.
      productName: DESKTOP_BRANDING.productName,
      // electron-builder reads the Windows version-resource CompanyName (and the NSIS
      // publisher line) from the manifest author, which the upstream manifest omits.
      author: { name: DESKTOP_BRANDING.companyName },
      copyright: DESKTOP_BRANDING.copyright,
      dshDesktopAppId: appId,
      dshDesktopUpdateChannel: update?.channel ?? 'nightly',
      ...(policy === undefined ? {} : { dshMandatoryUpdatePolicy: policy }),
      ...buildVersion === productVersion ? {} : { version: buildVersion },
      ...packaged === undefined ? {} : { dshBuildCommit: packaged.commit, dshBuildDirty: packaged.dirty },
    },
    productName: DESKTOP_BRANDING.productName,
    // Unsigned builds carry their own suffix so a shared file can never pass for a release artifact.
    artifactName: `deepseek-harness-\${version}-\${os}-\${arch}${output.suffix}.\${ext}`,
    directories: { output: output.directory },
    asar: true,
    electronDist: buildPaths.electron,
    electronFuses: { runAsNode: true },
    beforeBuild: async () => {
      // Hub build: the NSIS interface is native code compiled by MSVC. A Windows host compiles it
      // here, a cross installer embeds the assets verified above, and a directory build needs none.
      if (resolvedPlatform !== 'win32' || process.platform !== 'win32' || crossInstaller) return true
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./prepare-windows-installer.ps1', import.meta.url)),
        '-OutputDirectory', installerUiDirectory(buildPaths.root)], {
        env: scrubWindowsSigningEnvironment(env), windowsHide: true,
      })
      if (windowsSigner !== undefined) {
        await windowsSigner({ path: join(installerUiDirectory(buildPaths.root), 'window-frame.dll'), hash: 'sha256', isNest: false })
      }
      // A falsy result tells electron-builder to omit its production node_modules collection.
      return true
    },
    files: [
      'lib/main.js',
      'lib/welcome/**/*',
      'lib/preload-app.cjs',
      'lib/preload-mandatory.cjs',
      'lib/preload-platform-account.cjs',
      'lib/preload-update-dialog.cjs',
      'lib/preload-welcome.cjs',
      'renderer/**/*',
      'package.json',
      '!node_modules/**/*.{js,cjs,mjs,ts,cts,mts,css}.map',
      '!node_modules/**/*.tsbuildinfo',
      { from: buildPaths.dsh, to: 'dsh', filter: ['**/*'] },
      // electron-builder excludes a source directory's root node_modules.
      { from: join(buildPaths.dsh, 'node_modules'), to: 'dsh/node_modules', filter: ['**/*'] },
    ],
    asarUnpack: unpack,
    extraResources: [
      { from: buildPaths.runtime, to: 'runtime' },
      { from: brandedAssetPath(DESKTOP_BRANDING.iconPng), to: 'icon.png' },
      // Windows tray bitmaps; macOS keeps the Dock and ships no menu bar icon.
      ...(packagesWindows ? [{ from: brandedAssetPath(DESKTOP_BRANDING.trayIcon), to: 'tray.ico' }] : []),
    ],
    mac: {
      icon: fileURLToPath(new URL('../resources/icon-macos.png', import.meta.url)),
      category: 'public.app-category.developer-tools',
      // macOS matches the application locale against this bundle, not Electron Framework resources.
      extendInfo: { CFBundleLocalizations: ['en', 'zh_CN'] },
      // Ad-hoc signing keeps the modified Electron executable runnable without a Developer ID.
      identity: unsigned ? '-' : macOSSigning?.signingIdentity,
      forceCodeSigning: !unsigned,
      hardenedRuntime: true,
      extendInfo: { NSMicrophoneUsageDescription: `${DESKTOP_BRANDING.productName} uses your microphone to transcribe speech into message drafts.` },
      entitlements: fileURLToPath(new URL('./macos-entitlements.plist', import.meta.url)),
      entitlementsInherit: fileURLToPath(new URL('./macos-entitlements.plist', import.meta.url)),
      // Prepared runtime files retain their signatures; PAK resources are sealed by their enclosing bundle.
      signIgnore: ['/Contents/Resources/app\\.asar\\.unpacked/dsh(?:/|$)', '/Contents/Resources/runtime/primary-runtime(?:/|$)', '/Contents/Resources/runtime/pwsh(?:/|$)', '\\.pak$'],
      notarize: !unsigned && !skipNotarization,
      target: unsigned ? ['dmg'] : ['dmg', 'zip'],
    },
    dmg: {
      format: 'ULMO',
      sign: !unsigned,
      writeUpdateInfo: false,
    },
    beforePack: async context => {
      const office = await officePackageDirectories(buildPaths.dsh, { platform: resolvedPlatform, arch: resolvedArch })
      const patterns = office.map(directory => `**/${relative(buildPaths.dsh, directory).split(sep).join('/')}/**/*`)
      const existing = context.packager.config.asarUnpack ?? []
      context.packager.config.asarUnpack = [...(typeof existing === 'string' ? [existing] : existing), ...patterns]
      if (packagesWindows) windowsCode = await prepareWindowsAsarUnpack(context, buildPaths.dsh)
      if (windowsSigner !== undefined) {
        primaryRuntimeDestination = join(context.appOutDir, 'resources', 'runtime', 'primary-runtime')
        pwshDestination = join(context.appOutDir, 'resources', 'runtime', 'pwsh')
        dshDestination = join(context.appOutDir, 'resources', 'app.asar.unpacked', 'dsh')
      }
      if (policy === undefined) return
      const { resolveDesktopPolicyConfig } = await import('../lib/types/mandatory-update-policy.js')
      resolveDesktopPolicyConfig(policy)
    },
    afterPack: async context => {
      const { verifyDesktopRuntime } = await import('../lib/types/runtime-tree.js')
      const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
      if (resolvedPlatform === 'darwin' && update !== undefined) {
        await writeMacOSAppUpdateConfig(resourcesDir, resolveMacOSAppUpdateFeed(context.packager.config.publish),
          context.packager.appInfo.updaterCacheDirName)
      }
      // The bundled runtime declares whichever version prepared it: the product version for an ordinary
      // release, and a rewritten one for installed-update qualification.
      await verifyDesktopRuntime(buildPaths.dsh,
        preparedRuntimeVersion ?? productVersion, { platform: resolvedPlatform, arch: resolvedArch })
      // Unsigned Windows builds skip electron-builder's afterSign hook.
      if (packagesWindows && unsigned) await verifyWindowsAsarUnpack(buildPaths.dsh, resourcesDir, windowsCode)
    },
    afterSign: async context => {
      if (windowsSigner !== undefined) {
        await signWindowsCode(context.appOutDir, {
          thumbprint: new X509Certificate(await readFile(env.DSH_DESKTOP_WINDOWS_CER_FILE)).fingerprint.replaceAll(':', ''),
          sign: windowsSigner,
          record: event => recordPackagingEvent(env.DSH_DESKTOP_PACKAGING_RUN_DIR, event),
        })
        await verifyWindowsAsarUnpack(buildPaths.dsh, context.packager.getResourcesDir(context.appOutDir), windowsCode)
      }
      if (context.electronPlatformName !== 'darwin' || unsigned) return
      const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      if (update !== undefined) {
        await verifyMacOSAppUpdateConfig(appPath, resolveMacOSAppUpdateFeed(context.packager.config.publish),
          context.packager.appInfo.updaterCacheDirName)
      }
      verifyMacOSSignatureAfterSign(context, macOSSigning ?? resolveMacOSSigningEnvironment(env))
    },
    artifactBuildCompleted: artifact => {
      if (unsigned || !artifact.file.endsWith('.dmg')) return
      if (skipNotarization) {
        verifyMacOSDiskImageSignature(artifact.file, macOSSigning ?? resolveMacOSSigningEnvironment(env))
        return
      }
      return notarizeMacOSDiskImageArtifact(
        artifact,
        env,
        macOSSigning ?? resolveMacOSSigningEnvironment(env),
      )
    },
    win: {
      // Windows reads the per-size bitmaps of the ICO directly; a single PNG would be scaled by the shell.
      icon: brandedAssetPath(DESKTOP_BRANDING.iconIco),
      forceCodeSigning: !unsigned,
      signtoolOptions: {
        sign: windowsSigner,
        publisherName: windowsSigner === undefined ? undefined : resolveWindowsUpdatePublisher(env.DSH_DESKTOP_WINDOWS_CER_FILE),
        signingHashAlgorithms: ['sha256'],
      },
      target: ['nsis'],
    },
    linux: {
      category: 'Development',
      target: ['AppImage'],
    },
    nsis: {
      // Hub build: the Windows installer is the product users see, so it carries the product name.
      // Unsigned builds keep their suffix so a test artifact cannot pass for a release artifact.
      artifactName: `${DESKTOP_BRANDING.productName} Setup \${version}${output.suffix}.\${ext}`,
      installerSidebar: join(installerUiDirectory(buildPaths.root), 'uninstaller-sidebar.bmp'),
      uninstallerSidebar: join(installerUiDirectory(buildPaths.root), 'uninstaller-sidebar.bmp'),
      include: fileURLToPath(new URL('./installer.nsh', import.meta.url)),
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      installerLanguages: ['en_US', 'zh_CN'],
      differentialPackage: true,
    },
    detectUpdateChannel: false,
    publish: update === undefined ? null : [{ provider: 'generic', url: update.publicUrl, channel: update.channel }],
  }
}
