/** A Windows installer built on another host takes its Windows-only inputs from a Windows host. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { installUninstallerExtraction, installerUiDirectory, verifyInstallerUi } from '../hub/nsis-cross-package.mjs'

const require = createRequire(import.meta.url)
const assets = ['brand.bmp', 'brand-2x.bmp', 'brand-dark.bmp', 'brand-dark-2x.bmp', 'uninstaller-sidebar.bmp', 'window-frame.dll']

it('names every interface asset a Windows host still has to produce', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-installer-ui-'))
  try {
    expect(() => { verifyInstallerUi(directory) }).toThrow(`missing ${assets.join(', ')}`)
    for (const asset of assets.slice(0, -1)) writeFileSync(join(directory, asset), '')
    expect(() => { verifyInstallerUi(directory) }).toThrow('missing window-frame.dll')
    for (const asset of assets) writeFileSync(join(directory, asset), '')
    expect(() => { verifyInstallerUi(directory) }).not.toThrow()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('places the interface assets where installer.nsh looks for them', () => {
  expect(installerUiDirectory(join('build', 'win-x64'))).toBe(join('build', 'win-x64', 'installer-ui'))
})

it('pins the Windows 7-Zip toolset electron-builder itself verifies', () => {
  const source = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')), 'out/toolsets/7zip.js'), 'utf8')
  // The installer embeds this archive's bin/7za.exe; a stale digest would download a rejected tool.
  expect(source).toContain('"7zip-win-x64.tar.gz": "be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3"')
})

interface UninstallerReaderClass {
  exec: (installerPath: string, uninstallerPath: string) => Promise<void>
}
interface WineVmClass {
  new(): { exec: (file: string, args: string[]) => Promise<void> }
  readonly prototype: { exec: (file: string, args: string[]) => Promise<void> }
}

it.skipIf(process.platform === 'win32')('reads the uninstaller out of its generation installer instead of running wine', async () => {
  const { WineVmManager } = require('app-builder-lib/out/vm/WineVm.js') as { WineVmManager: WineVmClass }
  const { UninstallerReader } = require('app-builder-lib/out/targets/nsis/nsisUtil.js') as { UninstallerReader: UninstallerReaderClass }
  const read = vi.spyOn(UninstallerReader, 'exec').mockResolvedValue(undefined)
  try {
    installUninstallerExtraction()
    const patched = WineVmManager.prototype.exec
    installUninstallerExtraction()
    expect(WineVmManager.prototype.exec).toBe(patched)
    await new WineVmManager().exec(join('out', 'DSH Hub Setup 1.0.0-unsigned.exe'), [])
    // NSIS names the generated uninstaller after the installer, as the final script expects.
    expect(read).toHaveBeenCalledWith(join('out', 'DSH Hub Setup 1.0.0-unsigned.exe'),
      join('out', 'DSH Hub Setup 1.0.0-unsigned.__uninstaller.exe'))
  } finally {
    read.mockRestore()
  }
})
