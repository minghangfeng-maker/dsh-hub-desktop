/**
 * Render the DSH Hub Windows brand assets from the one vector source `hub/brand/source.svg`.
 *
 * The source holds one artboard per product surface: the large, small, and tiny
 * application icon, the tray glyph, the welcome-window wordmark, the installer
 * banner, and the uninstaller sidebar. The committed outputs are
 * `hub/icon-windows.png`, `hub/icon-windows.ico`, `hub/tray-windows.ico`,
 * `renderer/assets/welcome-brand.svg`, the five bitmaps under
 * `installer/assets/`, and the packaging sources under `resources/`, so a build
 * only reruns this script after the source changes:
 *
 *   pnpm --filter @deepseek-ai/dsh-desktop run render:brand
 *
 * Windows picks one bitmap of an ICO by display scale, so `icon-windows.ico`
 * packs a hand-drawn bitmap per size instead of downscaling one image: the word
 * "Hub" is unreadable below 64 px, where the hub ring carries the mark alone.
 * 16-128 px entries are uncompressed 32-bit bitmaps and the 256 px
 * entry is a PNG, the layout Windows documents for application icons.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { BRAND_SOURCE, ICON_ARTBOARDS, standaloneArtboard } from './brand-artboard.mjs'

export { BRAND_SOURCE, ICON_ARTBOARDS, readArtboard, standaloneArtboard } from './brand-artboard.mjs'

/**
 * Bitmap edges of the Windows application icon, each with the artboard drawn for it.
 *
 * 128 px and above render the painted master through `icon-large`; 64 px and below draw the
 * hand-tuned vector cuts, because the master's starlight body fades to a smudge at that edge.
 */
export const APPLICATION_ICON_ENTRIES = Object.freeze([
  Object.freeze({ size: 16, artboard: ICON_ARTBOARDS.tiny }),
  Object.freeze({ size: 24, artboard: ICON_ARTBOARDS.small }),
  Object.freeze({ size: 32, artboard: ICON_ARTBOARDS.small }),
  Object.freeze({ size: 48, artboard: ICON_ARTBOARDS.small }),
  Object.freeze({ size: 64, artboard: ICON_ARTBOARDS.vector }),
  Object.freeze({ size: 128, artboard: ICON_ARTBOARDS.large }),
  Object.freeze({ size: 256, artboard: ICON_ARTBOARDS.large }),
])

/** Tray bitmap edges: 16 px at 100 % through 32 px at 200 % display scale. */
export const TRAY_ICON_ENTRIES = Object.freeze([
  Object.freeze({ size: 16, artboard: ICON_ARTBOARDS.traySolid }),
  Object.freeze({ size: 20, artboard: ICON_ARTBOARDS.traySolid }),
  Object.freeze({ size: 24, artboard: ICON_ARTBOARDS.tray }),
  Object.freeze({ size: 32, artboard: ICON_ARTBOARDS.tray }),
])

/** Tray bitmap edges in ascending order, which is how the ICO directory lists them. */
export const TRAY_ICON_SIZES = Object.freeze(TRAY_ICON_ENTRIES.map((entry) => entry.size))

/** Committed output paths, relative to `apps/desktop`. */
export const BRAND_OUTPUTS = Object.freeze({
  iconPng: 'hub/icon-windows.png',
  iconIco: 'hub/icon-windows.ico',
  trayIco: 'hub/tray-windows.ico',
  wordmark: 'renderer/assets/welcome-brand.svg',
  installerBrand: 'installer/assets/brand.png',
  installerBrand2x: 'installer/assets/brand-2x.png',
  installerBrandDark: 'installer/assets/brand-dark.png',
  installerBrandDark2x: 'installer/assets/brand-dark-2x.png',
  uninstallerSidebar: 'installer/assets/uninstaller-sidebar.png',
  resourceIcon: 'resources/icon.svg',
  resourceIconWindows: 'resources/icon-windows.svg',
  resourceIconMacos: 'resources/icon-macos.svg',
  resourcePng: 'resources/icon.png',
  resourcePngWindows: 'resources/icon-windows.png',
  resourcePngMacos: 'resources/icon-macos.png',
})

/** Theme colors substituted into `{{token}}` placeholders for the rasterized artboards. */
export const BRAND_TOKENS = Object.freeze({
  light: Object.freeze({ labelPrimary: '#0F1115' }),
  dark: Object.freeze({ labelPrimary: '#F9FAFB' }),
})

const SOURCE_EDGE = 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICON_DIRECTORY_BYTES = 6
const ICON_ENTRY_BYTES = 16
const BITMAP_HEADER_BYTES = 40

/**
 * Rasterize a standalone SVG document at a target size.
 * @param svg - SVG markup with an intrinsic width.
 * @param width - Target pixel width; the height keeps the document's aspect ratio.
 * @returns PNG bytes.
 */
export async function renderPng(svg, width) {
  const documentWidth = Number(/^<svg[^>]* width="([^"]+)"/u.exec(svg)?.[1])
  if (!Number.isFinite(documentWidth) || documentWidth <= 0) throw new Error('brand render: SVG needs an intrinsic width')
  return sharp(Buffer.from(svg), { density: 72 * width / documentWidth }).resize({ width, fit: 'fill' }).png().toBuffer()
}

/**
 * Encode RGBA pixels as a Windows ICO bitmap entry.
 *
 * Icons store a device-independent bitmap whose declared height covers the color
 * rows and the 1-bit AND mask; 32-bit color rows carry the alpha channel, so the
 * mask stays clear.
 * @param size - Square edge in pixels.
 * @param rgba - Top-down RGBA pixels, `size * size * 4` bytes.
 * @returns BITMAPINFOHEADER, bottom-up BGRA rows, and the AND mask.
 */
export function bitmapEntry(size, rgba) {
  if (rgba.length !== size * size * 4) throw new Error(`brand icon: expected ${String(size * size * 4)} RGBA bytes`)
  const maskStride = Math.ceil(size / 32) * 4
  const maskBytes = maskStride * size
  const header = Buffer.alloc(BITMAP_HEADER_BYTES)
  header.writeUInt32LE(BITMAP_HEADER_BYTES, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(size * size * 4 + maskBytes, 20)
  const pixels = Buffer.alloc(size * size * 4)
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const from = (row * size + column) * 4
      const to = ((size - 1 - row) * size + column) * 4
      pixels[to] = rgba[from + 2]
      pixels[to + 1] = rgba[from + 1]
      pixels[to + 2] = rgba[from]
      pixels[to + 3] = rgba[from + 3]
    }
  }
  return Buffer.concat([header, pixels, Buffer.alloc(maskBytes)])
}

/**
 * Pack bitmaps into one Windows ICO file.
 * @param entries - Bitmaps in ascending edge length; each must be a square PNG or 32-bit bitmap of its declared edge.
 * @returns ICO bytes.
 */
export function packIcon(entries) {
  const header = Buffer.alloc(ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * entries.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach((entry, index) => {
    if (!Number.isInteger(entry.size) || entry.size < 1 || entry.size > 256) {
      throw new Error(`brand icon: unsupported bitmap edge ${String(entry.size)}`)
    }
    if (entry.format === 'png') {
      const { width, height } = pngDimensions(entry.data)
      if (width !== entry.size || height !== entry.size) {
        throw new Error(`brand icon: bitmap ${String(index)} is ${String(width)}x${String(height)}, expected ${String(entry.size)}`)
      }
    } else if (entry.format !== 'bmp') {
      throw new Error(`brand icon: bitmap ${String(index)} has no format`)
    }
    const at = ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * index
    // A 256 px edge is encoded as 0 in the one-byte directory fields.
    header.writeUInt8(entry.size % 256, at)
    header.writeUInt8(entry.size % 256, at + 1)
    header.writeUInt8(0, at + 2)
    header.writeUInt8(0, at + 3)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(entry.data.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += entry.data.length
  })
  return Buffer.concat([header, ...entries.map(entry => entry.data)])
}

/**
 * Read an ICO directory back.
 * @param ico - Bytes written by {@link packIcon}.
 * @returns One record per bitmap: declared edge, stored format, and payload.
 */
export function readIconDirectory(ico) {
  if (ico.length < ICON_DIRECTORY_BYTES || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error('brand icon: not an ICO file')
  }
  const count = ico.readUInt16LE(4)
  return Array.from({ length: count }, (_, index) => {
    const at = ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * index
    const declared = ico.readUInt8(at)
    const length = ico.readUInt32LE(at + 8)
    const offset = ico.readUInt32LE(at + 12)
    const data = ico.subarray(offset, offset + length)
    const format = data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? 'png' : 'bmp'
    const size = declared === 0 ? 256 : declared
    if (format === 'png') {
      const { width, height } = pngDimensions(data)
      if (width !== size || height !== size) throw new Error(`brand icon: entry ${String(index)} declares ${String(size)} but holds ${String(width)}x${String(height)}`)
    } else if (data.length < BITMAP_HEADER_BYTES || data.readInt32LE(4) !== size || data.readInt32LE(8) !== size * 2) {
      throw new Error(`brand icon: entry ${String(index)} declares ${String(size)} but its bitmap header disagrees`)
    }
    return { size, format, data }
  })
}

async function renderIconEntry(source, { size, artboard }, replacements) {
  const png = await renderPng(standaloneArtboard(source, artboard, replacements), size)
  if (size === 256) return { size, format: 'png', data: png }
  const rgba = await sharp(png).ensureAlpha().raw().toBuffer()
  return { size, format: 'bmp', data: bitmapEntry(size, rgba) }
}

/**
 * Render the application icon and the tray icon.
 * @param root - `apps/desktop` directory.
 * @param source - Vector source text.
 * @returns Written output paths.
 */
async function writeIcons(root, source) {
  const entries = []
  for (const entry of APPLICATION_ICON_ENTRIES) entries.push(await renderIconEntry(source, entry, {}))
  const png1024 = await renderPng(standaloneArtboard(source, ICON_ARTBOARDS.large, {}), SOURCE_EDGE)
  await writeFile(join(root, BRAND_OUTPUTS.iconPng), png1024)
  await writeFile(join(root, BRAND_OUTPUTS.iconIco), packIcon(entries))

  const tray = []
  for (const entry of TRAY_ICON_ENTRIES) {
    // The white rim keeps the navy whale readable on a dark taskbar; it stays one pixel wide,
    // so its vector width follows the bitmap edge. The stroke is drawn under the fill, which
    // hides its inner half and leaves a one-pixel rim outside the silhouette.
    const png = await renderPng(standaloneArtboard(source, entry.artboard, { 'tray-stroke': String(2 * SOURCE_EDGE / entry.size) }), entry.size)
    const rgba = await sharp(png).ensureAlpha().raw().toBuffer()
    tray.push({ size: entry.size, format: 'bmp', data: bitmapEntry(entry.size, rgba) })
  }
  await writeFile(join(root, BRAND_OUTPUTS.trayIco), packIcon(tray))
  return { application: entries.map(entry => entry.size), tray: TRAY_ICON_SIZES, png1024 }
}

/**
 * Render the wordmark and the installer bitmaps.
 * @param root - `apps/desktop` directory.
 * @param source - Vector source text.
 * @returns Written output paths.
 */
async function writeBrandImages(root, source) {
  const wordmark = standaloneArtboard(source, ICON_ARTBOARDS.wordmark)
  await writeFile(join(root, BRAND_OUTPUTS.wordmark), `${wordmark}\n`)

  const installerLight = standaloneArtboard(source, ICON_ARTBOARDS.installer, { 'label-primary': BRAND_TOKENS.light.labelPrimary })
  const installerDark = standaloneArtboard(source, ICON_ARTBOARDS.installer, { 'label-primary': BRAND_TOKENS.dark.labelPrimary })
  const brand = await renderPng(installerLight, 600)
  const brand2x = await renderPng(installerLight, 1200)
  const brandDark = await renderPng(installerDark, 600)
  const brandDark2x = await renderPng(installerDark, 1200)
  await writeFile(join(root, BRAND_OUTPUTS.installerBrand), brand)
  await writeFile(join(root, BRAND_OUTPUTS.installerBrand2x), brand2x)
  await writeFile(join(root, BRAND_OUTPUTS.installerBrandDark), brandDark)
  await writeFile(join(root, BRAND_OUTPUTS.installerBrandDark2x), brandDark2x)

  // NSIS sidebars are 24-bit bitmaps, so the sidebar artboard paints its own background.
  const sidebarSvg = standaloneArtboard(source, ICON_ARTBOARDS.sidebar)
  const sidebar = await sharp(await renderPng(sidebarSvg, 164)).removeAlpha().png().toBuffer()
  await writeFile(join(root, BRAND_OUTPUTS.uninstallerSidebar), sidebar)
  return { brand, brand2x, brandDark, brandDark2x, sidebar }
}

/**
 * Write the packaging sources under `resources/`: the vector rendition of the
 * application icon (electron-builder's icon inputs and the tray rasterizer, which
 * reads its `tray-glyph` group) plus the same 1024 px bitmap the about panel uses.
 * @param root - `apps/desktop` directory.
 * @param source - Vector source text.
 * @param iconPng - Rendered 1024 px application icon.
 * @returns Written output paths.
 */
async function writePackagingSources(root, source, iconPng) {
  const vector = `${standaloneArtboard(source, ICON_ARTBOARDS.vector)}\n`
  for (const output of [BRAND_OUTPUTS.resourceIcon, BRAND_OUTPUTS.resourceIconWindows, BRAND_OUTPUTS.resourceIconMacos]) {
    await writeFile(join(root, output), vector)
  }
  for (const output of [BRAND_OUTPUTS.resourcePng, BRAND_OUTPUTS.resourcePngWindows, BRAND_OUTPUTS.resourcePngMacos]) {
    await writeFile(join(root, output), iconPng)
  }
  return { iconPng, png: [BRAND_OUTPUTS.resourcePng, BRAND_OUTPUTS.resourcePngWindows, BRAND_OUTPUTS.resourcePngMacos] }
}

function pngDimensions(png) {
  if (png.length < 24 || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('brand icon: bitmap is not a PNG stream')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/**
 * Render every committed brand asset.
 * @param root - `apps/desktop` directory.
 * @returns Output paths the run wrote.
 */
export async function renderBrandAssets(root = fileURLToPath(new URL('..', import.meta.url))) {
  const source = await readFile(join(root, 'hub/brand/source.svg'), 'utf8')
  for (const directory of ['hub', 'renderer/assets', 'installer/assets']) await mkdir(join(root, directory), { recursive: true })
  const icons = await writeIcons(root, source)
  await writeBrandImages(root, source)
  await writePackagingSources(root, source, icons.png1024)
  const { png1024: _png1024, ...sizes } = icons
  return { iconPng: BRAND_OUTPUTS.iconPng, iconIco: BRAND_OUTPUTS.iconIco, trayIco: BRAND_OUTPUTS.trayIco, ...sizes }
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const result = await renderBrandAssets(root)
  console.info(`brand: icon-windows.png 1024 px; icon-windows.ico ${result.application.join(', ')} px; tray-windows.ico ${result.tray.join(', ')} px`)
  console.info(`brand: wordmark and installer bitmaps written under ${root}`)
  const previewAt = process.argv.indexOf('--preview')
  if (previewAt !== -1) {
    const { renderPreview } = await import('./brand/preview.mjs')
    const path = resolve(process.argv[previewAt + 1] ?? 'brand-preview.png')
    await mkdir(dirname(path), { recursive: true })
    await renderPreview({ root, outputPath: path, renderPng, standaloneArtboard })
    console.info(`brand: preview ${path}`)
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
