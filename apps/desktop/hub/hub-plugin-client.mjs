/**
 * Browser halves of the bundled Hub plugins.
 *
 * The Web client's module system serves a plugin's `exports["./client"]` and
 * expects a bundle that calls `window.__ModuleLoader__.load({ id, factory })`;
 * `packages/client/tsdown.client.ts` emits that wrapper for the repository's own
 * client packages. A Hub plugin is built by `prepare:hub-runtime` rather than by
 * that workspace build, so this module emits the same wrapper, and it resolves
 * the two placeholders a plugin may use to keep brand values single-sourced.
 */

/** Placeholder for the product name, filled from `hub/branding.mjs`. */
export const PRODUCT_NAME_PLACEHOLDER = '@@PRODUCT_NAME@@'

/** Placeholder for the sidebar mark as an SVG data URL, filled from `hub/brand/source.svg`. */
export const MARK_URL_PLACEHOLDER = '@@MARK_URL@@'

/** Any placeholder left after substitution. */
const ANY_PLACEHOLDER = /@@[A-Z_]+@@/u

/**
 * Encode one standalone SVG document as a CSS-safe data URL.
 * @param svg - SVG markup.
 * @returns `data:image/svg+xml;base64,…` URL.
 */
export function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

/**
 * Fill a plugin's browser-half placeholders.
 * @param body - Browser-half source text.
 * @param values - Product name and mark URL to substitute.
 * @returns The resolved body.
 * @throws {Error} When a placeholder stays unresolved.
 */
export function resolveClientHalf(body, values) {
  const resolved = body
    .replaceAll(PRODUCT_NAME_PLACEHOLDER, values.productName)
    .replaceAll(MARK_URL_PLACEHOLDER, values.markUrl)
  const unresolved = ANY_PLACEHOLDER.exec(resolved)
  if (unresolved !== null) throw new Error(`hub plugin client half: ${unresolved[0]} was not resolved`)
  return resolved
}

/**
 * Wrap a browser half as the module-table factory the client module system loads.
 * @param id - Package name the registration is keyed by.
 * @param body - Resolved browser-half source text.
 * @returns Bundle text, ending in one newline.
 */
export function wrapClientHalf(id, body) {
  return `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\n`
    + 'var module = { exports: {} }; var exports = module.exports;\n'
    + `${body}\nreturn module.exports; } });\n`
}
