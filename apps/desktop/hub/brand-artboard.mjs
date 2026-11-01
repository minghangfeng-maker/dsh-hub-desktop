/**
 * Artboard access for the DSH Hub vector source (`brand/source.svg`).
 *
 * The source is one file with a shared `<defs>` block and eight named
 * artboards, so every consumer needs the same two operations: read one
 * artboard and paste the shared definitions into it to get a standalone SVG.
 * This module carries no rasterizer, so the Host build can inline the sidebar
 * mark without loading `sharp`.
 */

import { fileURLToPath } from 'node:url'

/** Vector source every brand bitmap is rendered from. */
export const BRAND_SOURCE = fileURLToPath(new URL('./brand/source.svg', import.meta.url))

/** Artboards of the default (version A) source, by product surface. */
export const ICON_ARTBOARDS = Object.freeze({
  tiny: 'icon-tiny',
  small: 'icon-small',
  large: 'icon-large',
  tray: 'tray',
  traySolid: 'tray-solid',
  vector: 'icon-vector',
  wordmark: 'welcome-brand',
  installer: 'installer-brand',
  sidebar: 'uninstaller-sidebar',
})

/**
 * Read one artboard out of the vector source.
 * @param source - Complete text of `brand/source.svg`.
 * @param id - `id` attribute of the artboard's `<svg>` element.
 * @returns The artboard's attributes, inner markup, and the shared `<defs>` block.
 * @throws {Error} When the source has no such artboard or shared definitions.
 */
export function readArtboard(source, id) {
  const shared = source.match(/<defs id="hub-shared">[\s\S]*?<\/defs>/u)?.[0]
  if (shared === undefined) throw new Error('brand source: no shared artwork definitions')
  const pattern = new RegExp(`<svg id="${id}"([^>]*)>([\\s\\S]*?)</svg>`, 'u')
  const match = pattern.exec(source)
  if (match === null) throw new Error(`brand source: no artboard named ${id}`)
  const attributes = match[1]
  const viewBox = /viewBox="([^"]+)"/u.exec(attributes)?.[1]
  const width = /width="([^"]+)"/u.exec(attributes)?.[1]
  const height = /height="([^"]+)"/u.exec(attributes)?.[1]
  if (viewBox === undefined || width === undefined || height === undefined) {
    throw new Error(`brand source: artboard ${id} needs width, height, and viewBox`)
  }
  return { shared, body: match[2], width: Number(width), height: Number(height) }
}

/**
 * Build a standalone SVG document from one artboard.
 * @param source - Complete text of `brand/source.svg`.
 * @param id - Artboard name.
 * @param replacements - `{{token}}` values to substitute in the artboard and shared artwork.
 * @returns Standalone SVG markup, safe to rasterize or ship as an image asset.
 */
export function standaloneArtboard(source, id, replacements = {}) {
  const artboard = readArtboard(source, id)
  const apply = (text) => {
    let result = text
    for (const [token, value] of Object.entries(replacements)) result = result.replaceAll(`{{${token}}}`, value)
    const unresolved = /\{\{[a-z-]+\}\}/u.exec(result)
    if (unresolved !== null) throw new Error(`brand source: artboard ${id} leaves ${unresolved[0]} unset`)
    return result
  }
  return apply(`<svg xmlns="http://www.w3.org/2000/svg" width="${String(artboard.width)}" height="${String(artboard.height)}"`
    + ` viewBox="0 0 ${String(artboard.width)} ${String(artboard.height)}">${artboard.shared}${artboard.body}</svg>`)
}
