import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const applicationIcon = new URL('../hub/icon-windows.ico', import.meta.url)
const trayIcon = new URL('../hub/tray-windows.ico', import.meta.url)

/** One bitmap of an ICO directory, read the way Windows reads it. */
interface IconEntry {
  readonly size: number
  readonly format: 'bmp' | 'png'
  readonly bytes: number
  readonly data: Buffer
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Read an ICO directory and check each bitmap against its declared edge.
 * @param ico - Complete ICO bytes.
 * @returns One record per bitmap, in directory order.
 */
function readIconDirectory(ico: Buffer): IconEntry[] {
  expect(ico.readUInt16LE(0)).toBe(0)
  expect(ico.readUInt16LE(2)).toBe(1)
  const count = ico.readUInt16LE(4)
  return Array.from({ length: count }, (_, index) => {
    const at = 6 + 16 * index
    const declared = ico.readUInt8(at)
    const size = declared === 0 ? 256 : declared
    const bytes = ico.readUInt32LE(at + 8)
    const offset = ico.readUInt32LE(at + 12)
    const data = ico.subarray(offset, offset + bytes)
    if (data.subarray(0, 8).equals(PNG_SIGNATURE)) {
      expect({ width: data.readUInt32BE(16), height: data.readUInt32BE(20) }).toEqual({ width: size, height: size })
      return { size, format: 'png', bytes, data }
    }
    // BITMAPINFOHEADER: square color rows plus a 1-bit AND mask of the same edge.
    expect({ width: data.readInt32LE(4), height: data.readInt32LE(8) }).toEqual({ width: size, height: size * 2 })
    expect(data.readUInt16LE(14)).toBe(32)
    return { size, format: 'bmp', bytes, data }
  })
}

/** One decoded 32-bit ICO bitmap: top-down RGBA pixels plus the edge they cover. */
interface DecodedBitmap {
  readonly size: number
  readonly pixels: Buffer
}

/** Palette counts a tray bitmap is judged by: the brand body and the light rim. */
interface TrayColours {
  /** Opaque pixels (alpha 255), the ones Windows paints. */
  readonly opaque: number
  /** Opaque pixels in the brand-navy family: a blue channel well above both red and green. */
  readonly navy: number
  /** Opaque pixels bright enough to be the rim rather than the body. */
  readonly rim: number
  /** Mean colour of the opaque pixels. */
  readonly mean: { readonly red: number; readonly green: number; readonly blue: number }
}

/**
 * Decode an ICO bitmap entry into top-down RGBA.
 * @param entry - One directory record whose format is `bmp`.
 * @returns The bitmap, ready for pixel assertions.
 */
function decodeBitmap(entry: IconEntry): DecodedBitmap {
  const { size, data } = entry
  const pixels = Buffer.alloc(size * size * 4)
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const from = 40 + ((size - 1 - row) * size + column) * 4
      const to = (row * size + column) * 4
      pixels[to] = data[from + 2] ?? 0
      pixels[to + 1] = data[from + 1] ?? 0
      pixels[to + 2] = data[from] ?? 0
      pixels[to + 3] = data[from + 3] ?? 0
    }
  }
  return { size, pixels }
}

/**
 * Count the brand-navy body and the light rim of one decoded tray bitmap.
 * @param bitmap - Decoded tray bitmap.
 * @returns Pixel counts and the mean opaque colour.
 */
function trayColours(bitmap: DecodedBitmap): TrayColours {
  let opaque = 0
  let navy = 0
  let rim = 0
  let red = 0
  let green = 0
  let blue = 0
  for (let at = 0; at < bitmap.pixels.length; at += 4) {
    if (bitmap.pixels[at + 3] !== 255) continue
    const r = bitmap.pixels[at] ?? 0
    const g = bitmap.pixels[at + 1] ?? 0
    const b = bitmap.pixels[at + 2] ?? 0
    opaque += 1
    red += r
    green += g
    blue += b
    // The body runs the night-sky gradient #080E3D → #2A1460 (or the flat #141A4E): blue is always
    // well above both red and green, which the white rim is not.
    if (b >= 60 && b - r >= 25 && b - g >= 25) navy += 1
    if (r > 200 && g > 200 && b > 200) rim += 1
  }
  return {
    opaque,
    navy,
    rim,
    mean: { red: Math.round(red / opaque), green: Math.round(green / opaque), blue: Math.round(blue / opaque) },
  }
}

/** PNG pixel dimensions, read from IHDR. */
function pngSize(url: URL): { width: number; height: number } {
  const png = readFileSync(url)
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

describe('DSH Hub brand artwork', () => {
  it('packs the Windows application icon with one bitmap per size and a PNG 256 px entry', () => {
    const entries = readIconDirectory(readFileSync(applicationIcon))
    expect(entries.map(entry => entry.size)).toEqual([16, 24, 32, 48, 64, 128, 256])
    // Windows draws 16-128 px from uncompressed bitmaps; the 256 px entry may be a PNG stream.
    expect(entries.map(entry => entry.format)).toEqual(['bmp', 'bmp', 'bmp', 'bmp', 'bmp', 'bmp', 'png'])
    for (const entry of entries) expect(entry.bytes).toBeGreaterThan(100)
  })

  it('packs the tray icon for 100 % through 200 % display scale', () => {
    const entries = readIconDirectory(readFileSync(trayIcon))
    expect(entries.map(entry => entry.size)).toEqual([16, 20, 24, 32])
    for (const entry of entries) expect(entry.format).toBe('bmp')
  })

  it('paints the tray mark brand navy under a one-pixel light rim at every size', () => {
    const entries = readIconDirectory(readFileSync(trayIcon))
    for (const entry of entries) {
      const colours = trayColours(decodeBitmap(entry))
      // The body, not the rim, is most of the glyph: a white mark on a light taskbar
      // is exactly the state this colour change removes.
      expect(colours.navy / colours.opaque, `${String(entry.size)} px brand-navy share`).toBeGreaterThan(0.6)
      expect(colours.rim / colours.opaque, `${String(entry.size)} px rim share`).toBeGreaterThan(0.01)
      expect(colours.rim, `${String(entry.size)} px rim share`).toBeLessThan(colours.navy)
      expect(colours.mean.blue, `${String(entry.size)} px mean blue`).toBeGreaterThan(90)
      expect(colours.mean.blue - colours.mean.red, `${String(entry.size)} px mean hue`).toBeGreaterThan(20)
    }
  })

  it('keeps the about-panel PNG beside the ICO both packaging paths read', () => {
    expect(pngSize(new URL('../hub/icon-windows.png', import.meta.url))).toEqual({ width: 1024, height: 1024 })
    expect(existsSync(applicationIcon)).toBe(true)
    expect(existsSync(trayIcon)).toBe(true)
  })

  it('renders the installer bitmaps at the sizes the NSIS pages place them', () => {
    expect(pngSize(new URL('../installer/assets/brand.png', import.meta.url))).toEqual({ width: 600, height: 196 })
    expect(pngSize(new URL('../installer/assets/brand-2x.png', import.meta.url))).toEqual({ width: 1200, height: 392 })
    expect(pngSize(new URL('../installer/assets/brand-dark.png', import.meta.url))).toEqual({ width: 600, height: 196 })
    expect(pngSize(new URL('../installer/assets/brand-dark-2x.png', import.meta.url))).toEqual({ width: 1200, height: 392 })
    expect(pngSize(new URL('../installer/assets/uninstaller-sidebar.png', import.meta.url))).toEqual({ width: 164, height: 314 })
  })

  it('keeps the welcome wordmark on the welcome window canvas and theme variables', () => {
    const wordmark = readFileSync(new URL('../renderer/assets/welcome-brand.svg', import.meta.url), 'utf8')
    expect(wordmark).toMatch(/^<svg [^>]*width="472" height="40" viewBox="0 0 472 40"/u)
    expect(wordmark).toContain('--dsw-alias-label-primary:')
    expect(wordmark).toContain('prefers-color-scheme: dark')
    expect(wordmark).toContain('var(--dsw-alias-label-primary)')
  })

  it('ships a source artboard for every committed output', () => {
    const source = readFileSync(new URL('../hub/brand/source.svg', import.meta.url), 'utf8')
    for (const artboard of ['icon-large', 'icon-vector', 'icon-small', 'icon-tiny', 'tray',
      'tray-solid', 'welcome-brand', 'installer-brand', 'uninstaller-sidebar']) {
      expect(source).toContain(`<svg id="${artboard}" width=`)
    }
    // The tray colour is source-owned: the small sizes take the flat brand navy, the large ones
    // the same tile gradient as the application icon, both filled over the white rim the renderer
    // strokes below the fill. The glyph is filled (a silhouette), never stroked in white itself,
    // which is what keeps it readable at 16 px.
    const tray = /<svg id="tray" width="1024"[\s\S]*?<\/svg>/u.exec(source)?.[0] ?? ''
    const traySolid = /<svg id="tray-solid" width="1024"[\s\S]*?<\/svg>/u.exec(source)?.[0] ?? ''
    expect(tray).toContain('fill="url(#hub-tile)"')
    expect(traySolid).toContain('fill="#141A4E"')
    expect(source).toMatch(/<path id="whale-silhouette" fill-rule="evenodd"/u)
    for (const artboard of [tray, traySolid]) {
      expect(artboard).toContain('href="#whale-silhouette"')
      expect(artboard).toContain('stroke="#FFFFFF"')
      expect(artboard).toContain('stroke-width="{{tray-stroke}}"')
      expect(artboard).not.toContain('fill="#FFFFFF"')
    }
  })

  it('writes the packaging sources electron-builder and the tray renderer read', () => {
    for (const name of ['icon', 'icon-windows', 'icon-macos']) {
      const svg = readFileSync(new URL(`../resources/${name}.svg`, import.meta.url), 'utf8')
      // `scripts/render-tray-icon.ts` scales this group to build resources/tray-windows.ico.
      expect(svg).toContain('<g id="tray-glyph">')
      expect(svg).toContain('fill="url(#hub-tile)"')
      expect(pngSize(new URL(`../resources/${name}.png`, import.meta.url))).toEqual({ width: 1024, height: 1024 })
    }
  })

  it('points the Windows packaging target at the multi-size ICO and the about panel at the PNG', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'tech.dshhub.desktop',
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(config.win.icon).toBe(fileURLToPath(applicationIcon))
    const aboutIcon = config.extraResources.find(resource => resource.to === 'icon.png')
    expect(aboutIcon?.from).toBe(fileURLToPath(new URL('../hub/icon-windows.png', import.meta.url)))
    const packagedTray = config.extraResources.find(resource => resource.to === 'tray.ico')
    expect(packagedTray?.from).toBe(fileURLToPath(trayIcon))
  })
})
