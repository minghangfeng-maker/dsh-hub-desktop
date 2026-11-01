/** Types for the bundled Hub plugins' browser-half wrapper. */

/** Placeholder for the product name, filled from `hub/branding.mjs`. */
export declare const PRODUCT_NAME_PLACEHOLDER: '@@PRODUCT_NAME@@'

/** Placeholder for the sidebar mark as an SVG data URL. */
export declare const MARK_URL_PLACEHOLDER: '@@MARK_URL@@'

/**
 * Encode one standalone SVG document as a data URL.
 * @param svg - SVG markup.
 * @returns `data:image/svg+xml;base64,…` URL.
 */
export declare function svgDataUrl(svg: string): string

/**
 * Fill a plugin's browser-half placeholders.
 * @param body - Browser-half source text.
 * @param values - Product name and mark URL to substitute.
 * @returns The resolved body.
 */
export declare function resolveClientHalf(body: string, values: { productName: string; markUrl: string }): string

/**
 * Wrap a browser half as the module-table factory the client module system loads.
 * @param id - Package name the registration is keyed by.
 * @param body - Resolved browser-half source text.
 * @returns Bundle text, ending in one newline.
 */
export declare function wrapClientHalf(id: string, body: string): string
