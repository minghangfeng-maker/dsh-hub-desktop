# DSH Hub Windows brand artwork

One source, `source.svg`, holds every Windows surface of the DSH Hub identity as a named artboard.
`../render-brand.mjs` extracts an artboard, substitutes the theme tokens, rasterizes it with sharp, and
writes the committed outputs. Rerun after changing the source:

```sh
cd apps/desktop
pnpm run render:brand        # icons, tray, wordmark, installer bitmaps, resources/ packaging sources
pnpm run render:tray-icon    # resources/tray-windows.ico, read back from resources/icon-windows.svg
# review sheet:
node hub/render-brand.mjs --preview /path/to/preview.png
```

## Artboards

| Artboard | Output | Surface |
| --- | --- | --- |
| `icon-large` | `hub/icon-windows.ico` 128, 256 px; `hub/icon-windows.png` 1024 px | the painted master, embedded in the source |
| `icon-vector` | `resources/icon{,-windows,-macos}.{svg,png}` | vector rendition of the icon: electron-builder's icon inputs and the tray rasterizer |
| `icon-small` | `hub/icon-windows.ico` 24, 32, 48 px | whale drawn at 3.4 units, twelve star points |
| `icon-tiny` | `hub/icon-windows.ico` 16 px | whale drawn at 6 units, no star points |
| `tray` / `tray-solid` | `hub/tray-windows.ico` 24, 32 / 16, 20 px | navy whale silhouette under a one-pixel white rim |
| `welcome-brand` | `renderer/assets/welcome-brand.svg` | welcome window wordmark, 472 × 40 |
| `installer-brand` | `installer/assets/brand*.png` | NSIS welcome and progress banner, 600 × 196 and 1200 × 392 |
| `uninstaller-sidebar` | `installer/assets/uninstaller-sidebar.png` | NSIS sidebar, 164 × 314 |

The same artboards also produce the platform icons Electron and the packaging configuration read
(`resources/icon.svg`, `resources/icon-windows.svg`, `resources/icon-macos.svg`, their 1024 px PNG
exports, and `resources/tray-windows.ico`, rendered by `scripts/render-tray-icon.ts` from the
`tray-glyph` group of `resources/icon-windows.svg`), so no upstream product artwork is left in the
build.

The wordmark keeps the welcome window's theme mechanism: it declares the same
`--dsw-alias-label-primary` custom property and `prefers-color-scheme` query as the file it replaced,
so the label follows the shell theme. The installer banner has no live theme, so its artboard carries a
`{{label-primary}}` token that the renderer replaces per theme before rasterizing.

## Source of the mark

The mark is a **constellation whale**: one continuous outline threaded through sixteen star points, with
a four-point star for the eye, drawn in white on the night-sky tile (`#080E3D` → `#2A1460` gradient). It
is DSH Hub's own artwork, authored for this fork; it carries no DeepSeek mark, wordmark, or other
upstream artwork, and the build uses neither the DeepSeek nor the DeepSeek Harness wordmark.

Sizes are not one drawing scaled down. Between 16 and 64 px the outline is hand-tuned — `whale-16`
(6 units, no star points), `whale-bold` (3.4 units, twelve points), `whale-line` (2.2 units, sixteen
points) — because a 2.2-unit line on a 1024-unit canvas is well under a pixel at 16 px and vanishes.
From 128 px up the artboards use the painted master: `icon-large` embeds the 1024 px PNG straight in the
source (`<image href="data:image/png;base64,…">`), which is why that artboard, and the standalone
documents built from it, carry a large literal. One file still produces every output, and the renderer
needs no second lookup.

The tray glyph is the one place the mark is **filled rather than stroked**: `whale-silhouette` closes the
outline and knocks the eye out with `fill-rule="evenodd"`. A silhouette is what survives 16 px, and it
keeps the one-colour-plus-rim rendering the ring used before. The glyph is scaled 1.2× about the
artboard centre so it fills the tray box; without that, a one-pixel rim around thin strokes was most of
what a 16 px bitmap showed.

The tray glyph carries the brand navy rather than the theme label colour: the 24 px and 32 px bitmaps
fill the silhouette with the same `hub-tile` gradient as the application icon, the 16 px and 20 px
bitmaps use the flat `#141A4E` because a gradient has no room to read at that edge. The rim is white and
stays one pixel wide at every size: over the navy body it separates the glyph from the dark Windows 11
taskbar, and on the light taskbar it disappears into the background, where the navy body itself carries
the mark.

## Type

The wordmark is **Montserrat** (Medium for "Hub", Light for "DSH"), the brand family the welcome
window already loads from `packages/client/ui-theme/src/styles/montserrat-*.woff2`. The glyphs are
outlined to paths with fontTools and embedded in the source, so rendering never depends on an
installed font. Montserrat is licensed under the **SIL Open Font License 1.1**; the license text ships
with the font at `packages/client/ui-theme/src/styles/Montserrat-OFL.txt` and is copied into the
welcome window bundle as `Montserrat-OFL.txt`.
