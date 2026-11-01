# @dsh-hub/hub-brand

English | [中文](README.zh.md)

DSH Hub occupants for the Web client's sidebar brand slots.

Upstream fills `sidebar.brand.mark` and `sidebar.brand.name` with the official
DeepSeek Harness occupants (`@deepseek-ai/dsh-client-ui-brand-official`). A Hub
desktop shows its own product there instead: this bundle disables that row and
registers the DSH Hub mark and name into the same two slots, which are the
documented extension points of the upstream sidebar.

- **Host half** (`src/index.ts`): an empty `apply`; the row exists so the package
  is part of the profile composition and its client bundle enters the boot graph.
- **Browser half** (`client/index.js`): a module-table factory that registers the
  two slot occupants. `prepare:hub-runtime` wraps it as `lib/client.js` and fills
  two placeholders: `@@PRODUCT_NAME@@` from `apps/desktop/hub/branding.mjs`, and
  `@@MARK_URL@@` from the `icon-small` artboard of `apps/desktop/hub/brand/source.svg`
  (base64 SVG data URL), so the sidebar mark is the same artwork as the window icon.

The mark follows the window icon and tray; the name is text inside the sidebar's
own 18 px/600 row, so it inherits the theme colors and needs no second artwork.
