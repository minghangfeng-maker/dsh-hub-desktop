/**
 * Screenshot hook for acceptance runs.
 *
 * A packaged desktop is the only place some product surfaces can be seen: the
 * welcome window is a sandboxed renderer that never appears in a browser, and the
 * workspace chrome is drawn by the shell. Driving a real desktop input device to
 * photograph it is neither scriptable nor safe, so the shell exposes one opt-in
 * hook: with `DSH_DESKTOP_CAPTURE_DIR` set, it writes a PNG of a named window once
 * that window has painted. The hook is inert unless the variable names a
 * directory, and it never affects what the window renders.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/** A blank 900x1000 frame encodes to a few kilobytes; a rendered page is far larger. */
const MIN_INTERESTING_BYTES = 12_000

/** Environment variable naming the directory captures land in. */
export const CAPTURE_DIRECTORY_ENV = 'DSH_DESKTOP_CAPTURE_DIR'

/** Delays to try: a cold renderer can take seconds before its first painted frame. */
const ATTEMPTS_MS = [2_000, 5_000, 9_000, 14_000]

/**
 * Capture one window's visible contents into the configured directory.
 * @param window - Window to photograph; skipped when it is gone.
 * @param name - File stem, written as `<name>.png`.
 * @param attempt - Retry counter for a window that has not painted yet.
 */
export function captureWindow(window: BrowserWindow | undefined, name: string): void {
  const directory = process.env[CAPTURE_DIRECTORY_ENV] ?? ''
  if (directory === '' || window === undefined || window.isDestroyed()) return
  for (const delay of ATTEMPTS_MS) {
    setTimeout(() => {
      if (window.isDestroyed()) return
      void window.webContents.capturePage().then((image) => {
        const png = image.toPNG()
        // A window that has not painted yet photographs as one flat colour; the later
        // attempt overwrites it, so the file keeps the first painted frame.
        if (png.byteLength < MIN_INTERESTING_BYTES) {
          console.info(`desktop capture: ${name} not painted yet after ${String(delay)} ms`)
          return
        }
        mkdirSync(directory, { recursive: true })
        writeFileSync(join(directory, `${name}.png`), png)
        console.info(`desktop capture: ${name}.png (${String(png.byteLength)} bytes, ${String(delay)} ms)`)
      }).catch((error: unknown) => {
        console.warn(`desktop capture: ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, delay)
  }
}
