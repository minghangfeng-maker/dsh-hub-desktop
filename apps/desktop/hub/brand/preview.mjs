/**
 * Compose the design-review sheet for the DSH Hub application icon and tray glyph.
 *
 * The sheet is review material, not a shipped asset: the 256, 64, 32, and 16 px
 * bitmaps on a light and a dark background, the small sizes enlarged to whole
 * pixels, and a simulated taskbar strip showing the shipped tray bitmaps.
 * `node hub/render-brand.mjs --preview <path>` writes it.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

/** Layouts the sheet compares; the first one is the shipped default. */
const LAYOUTS = Object.freeze([
  Object.freeze({
    id: 'A',
    source: 'hub/brand/source.svg',
    title: '星座鲸',
    detail: '夜空底上一头由星点连成的鲸鱼，眼睛是四角闪星；128 px 起用母版，64 px 及以下用矢量加粗版',
  }),
])

const CANVAS_BACKGROUND = '#E9EDF5'
const PANEL = Object.freeze({ light: '#FFFFFF', dark: '#15171C' })
const STRIP = Object.freeze({ light: '#F3F3F3', dark: '#1E1E1E' })
const LABEL = Object.freeze({ light: '#4B5563', dark: '#9AA1AC' })
const PLACEHOLDER = Object.freeze({ light: '#CBD1DA', dark: '#4A4F58' })

const LABEL_WIDTH = 250
const GAP = 20
const PANEL_WIDTH = 640
const PANEL_HEIGHT = 330
const STRIP_GAP = 10
const STRIP_HEIGHT = 48

/** Icons shown inside one panel; `zoom` enlarges with whole pixels so the artifact stays visible. */
const ICONS = Object.freeze([
  Object.freeze({ size: 256, artboard: 'icon-large', x: 24, y: 36, label: '256 px' }),
  Object.freeze({ size: 64, artboard: 'icon-large', x: 300, y: 36, label: '64 px' }),
  Object.freeze({ size: 32, artboard: 'icon-small', x: 384, y: 36, label: '32 px' }),
  Object.freeze({ size: 16, artboard: 'icon-tiny', x: 440, y: 36, label: '16 px' }),
  Object.freeze({ size: 32, artboard: 'icon-small', x: 300, y: 140, zoom: 4, label: '32 px ×4' }),
  Object.freeze({ size: 16, artboard: 'icon-tiny', x: 452, y: 140, zoom: 8, label: '16 px ×8' }),
])

function escapeText(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Split a caption into lines of about `limit` half-width units, so CJK text wraps. */
function wrap(text, limit) {
  const lines = []
  let line = ''
  let units = 0
  for (const character of text) {
    const width = /[\u3000-\u9fff]/u.test(character) ? 2 : 1
    if (units + width > limit && line !== '') {
      lines.push(line)
      line = ''
      units = 0
    }
    line += character
    units += width
  }
  if (line !== '') lines.push(line)
  return lines
}

function panelSvg(theme, left) {
  const pieces = [
    `<rect x="${left}" y="0" width="${PANEL_WIDTH}" height="${PANEL_HEIGHT}" rx="14" fill="${PANEL[theme]}"/>`,
    `<text x="${left + 24}" y="22" font-family="DejaVu Sans, sans-serif" font-size="12" fill="${LABEL[theme]}">${theme === 'light' ? '浅色背景' : '深色背景'}</text>`,
  ]
  for (const icon of ICONS) {
    const display = icon.size * (icon.zoom ?? 1)
    pieces.push(`<text x="${left + icon.x}" y="${icon.y + display + 18}" font-family="DejaVu Sans, sans-serif" font-size="11" fill="${LABEL[theme]}">${icon.label}</text>`)
  }
  const stripTop = PANEL_HEIGHT + STRIP_GAP
  pieces.push(`<rect x="${left}" y="${stripTop}" width="${PANEL_WIDTH}" height="${STRIP_HEIGHT}" rx="8" fill="${STRIP[theme]}"/>`)
  for (let index = 0; index < 3; index += 1) {
    pieces.push(`<circle cx="${left + 120 + index * 40}" cy="${stripTop + STRIP_HEIGHT / 2}" r="9" fill="${PLACEHOLDER[theme]}"/>`)
  }
  pieces.push(`<text x="${left + PANEL_WIDTH - 20}" y="${stripTop + 29}" text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="11" fill="${LABEL[theme]}">模拟任务栏 · ${theme === 'light' ? '浅色' : '深色'}</text>`)
  return pieces
}

async function renderLayoutRow(base, layout, { renderPng, standaloneArtboard }) {
  const source = await readFile(join(base, layout.source), 'utf8')
  const rowWidth = LABEL_WIDTH + GAP * 3 + PANEL_WIDTH * 2
  const rowHeight = PANEL_HEIGHT + STRIP_GAP + STRIP_HEIGHT
  const panels = { light: LABEL_WIDTH + GAP, dark: LABEL_WIDTH + GAP * 2 + PANEL_WIDTH }

  const pieces = [
    `<text x="0" y="26" font-family="DejaVu Sans, sans-serif" font-size="19" fill="#111827">${escapeText(layout.title)}</text>`,
    ...wrap(layout.detail, 26).map((line, index) => `<text x="0" y="${60 + index * 20}" font-family="DejaVu Sans, sans-serif" font-size="12" fill="#4B5563">${escapeText(line)}</text>`),
  ]
  const composites = []
  for (const [theme, left] of Object.entries(panels)) {
    pieces.push(...panelSvg(theme, left))
    for (const icon of ICONS) {
      const png = await renderPng(standaloneArtboard(source, icon.artboard), icon.size)
      const display = icon.size * (icon.zoom ?? 1)
      const scaled = display === icon.size ? png : await sharp(png).resize(display, display, { kernel: 'nearest' }).png().toBuffer()
      composites.push({ input: scaled, left: left + icon.x, top: icon.y })
    }
    // The strip shows the shipped tray bitmaps at their real tray size, with the same one-pixel
    // rim token the renderer substitutes.
    const tray24 = await renderPng(standaloneArtboard(source, 'tray', { 'tray-stroke': String(2 * 1024 / 24) }), 24)
    const tray16 = await renderPng(standaloneArtboard(source, 'tray-solid', { 'tray-stroke': String(2 * 1024 / 16) }), 16)
    const stripTop = PANEL_HEIGHT + STRIP_GAP
    composites.push({ input: tray24, left: left + 24, top: stripTop + 12 })
    composites.push({ input: tray16, left: left + 68, top: stripTop + 16 })
  }

  const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${rowWidth}" height="${rowHeight}">${pieces.join('')}</svg>`)
  const row = await sharp(background).composite(composites).png().toBuffer()
  return { row, rowWidth, rowHeight }
}

/**
 * Render the layout comparison sheet.
 * @param options - Preview inputs.
 * @param options.root - `apps/desktop` directory.
 * @param options.outputPath - Absolute path of the PNG to write.
 * @param options.renderPng - Renderer for one artboard at a pixel edge.
 * @param options.standaloneArtboard - Artboard extractor of the vector source.
 * @returns Size of the written PNG.
 */
export async function renderPreview({ root, outputPath, renderPng, standaloneArtboard }) {
  const rows = []
  for (const layout of LAYOUTS) rows.push(await renderLayoutRow(root, layout, { renderPng, standaloneArtboard }))
  const width = Math.max(...rows.map(row => row.rowWidth))
  const height = rows.reduce((total, row) => total + row.rowHeight + 24, 32)
  const composites = []
  let top = 32
  for (const row of rows) {
    composites.push({ input: row.row, left: 0, top })
    top += row.rowHeight + 24
  }
  const image = await sharp({ create: { width, height, channels: 4, background: CANVAS_BACKGROUND } })
    .composite(composites).png().toFile(outputPath)
  return { width: image.width, height: image.height }
}
