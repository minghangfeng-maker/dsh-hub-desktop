/** Types for the artboard accessors the Host build uses to inline the sidebar mark. */

/** Vector source of every brand bitmap. */
export declare const BRAND_SOURCE: string

/** Named artboards of the version A source. */
export declare const ICON_ARTBOARDS: {
  readonly tiny: 'icon-tiny'
  readonly small: 'icon-small'
  readonly large: 'icon-large'
  readonly tray: 'tray'
  readonly traySolid: 'tray-solid'
  readonly wordmark: 'welcome-brand'
  readonly installer: 'installer-brand'
  readonly sidebar: 'uninstaller-sidebar'
}

/** One artboard's geometry-independent content. */
export interface BrandArtboard {
  /** Shared `<defs>` block the artboard references. */
  readonly shared: string
  /** Artboard markup without its `<svg>` wrapper. */
  readonly body: string
  /** Declared width in source units. */
  readonly width: number
  /** Declared height in source units. */
  readonly height: number
}

/**
 * Read one artboard out of the vector source.
 * @param source - Complete text of `brand/source.svg`.
 * @param id - `id` attribute of the artboard's `<svg>` element.
 * @returns The artboard's content, shared definitions, and declared size.
 */
export declare function readArtboard(source: string, id: string): BrandArtboard

/**
 * Build a standalone SVG document from one artboard.
 * @param source - Complete text of `brand/source.svg`.
 * @param id - Artboard name.
 * @param replacements - `{{token}}` values to substitute in the artboard and shared artwork.
 * @returns Standalone SVG markup.
 */
export declare function standaloneArtboard(source: string, id: string, replacements?: Record<string, string>): string
