/**
 * Browser half of the DSH Hub brand plugin.
 *
 * The bundle is a module-table factory: the Host build wraps this file in
 * `window.__ModuleLoader__.load({ id, factory: (require) => … })`, so only
 * platform modules may be required (`react` here) and everything else has to
 * live in this file.
 *
 * Two placeholders are resolved by the Host build (`prepare-hub-runtime.ts`),
 * because the product name and the mark both have a single owner outside this
 * package: `@@PRODUCT_NAME@@` comes from `apps/desktop/hub/branding.mjs`, and
 * `@@MARK_URL@@` is the `icon-small` artboard of `hub/brand/source.svg` encoded
 * as a data URL, so the sidebar mark is the same artwork as the window icon.
 */

const React = require('react')

const h = React.createElement

/** Product name the Host build stamped in. */
const PRODUCT_NAME = '@@PRODUCT_NAME@@'

/** Sidebar mark, inlined by the Host build as an SVG data URL. */
const MARK_URL = '@@MARK_URL@@'

/** Style element identity; one element per document however often the plugin mounts. */
const STYLE_ID = 'dsh-hub-brand'

/**
 * The mark keeps the pixel size the slot passes in (`width`/`height` attributes);
 * a percentage rule would outrank those attributes and paint the artwork at its
 * intrinsic 1024 px. The name slot's parent already sets 18 px/600 with 0.04em
 * tracking, so the name only has to stop wrapping.
 */
const CSS = `
.dsh-hub-brand-mark { display: block; flex: none; border-radius: 6px; }
.dsh-hub-brand-name { display: inline-block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`

/** Services this plugin needs: the UI slot registry. */
exports.inject = ['slots']

/**
 * Render the DSH Hub mark, the same tile the window icon and the tray use.
 *
 * Both slots that take a mark pass `size`; the hero also passes the class its
 * layout expects (the fallback fish is wider than it is tall), so the class rides
 * along instead of being replaced.
 * @param {{ size?: number, className?: string }} props - Mark geometry from the owner slot.
 * @returns {object} the mark image element.
 */
function BrandMark(props) {
  const size = typeof props.size === 'number' ? props.size : 24
  const className = ['dsh-hub-brand-mark', typeof props.className === 'string' ? props.className : '']
    .filter(Boolean).join(' ')
  return h('img', { className, src: MARK_URL, width: size, height: size, alt: '', draggable: false })
}

/**
 * Render the DSH Hub name.
 * @returns {object} the wordmark text element.
 */
function BrandName() {
  return h('span', { className: 'dsh-hub-brand-name' }, PRODUCT_NAME)
}

/**
 * Fill the sidebar's brand slots with the Hub occupants.
 * @param {object} ctx - Client root context.
 * @returns {void}
 */
exports.apply = function apply(ctx) {
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    if (document.querySelector(`style[data-hub-brand="${STYLE_ID}"]`) === null) {
      const style = document.createElement('style')
      style.dataset.hubBrand = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }
    return () => {
      const style = document.querySelector(`style[data-hub-brand="${STYLE_ID}"]`)
      if (style !== null) style.remove()
    }
  }, 'hub-brand: stylesheet')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* registerBrand() {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, BrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, BrandName)
    }))
  // The New Session headline shows a mark of its own; upstream falls back to the
  // animated official fish, which a DSH Hub build cannot show either. This slot
  // belongs to another package's registration, so it waits for that declaration
  // on its own: registering into the sidebar chain would let a late hero
  // declaration reject the whole set and empty the sidebar brand too.
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, BrandMark))
}
