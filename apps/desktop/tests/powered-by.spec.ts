/**
 * "Powered by xdedmi" is the one vendor line this build shows (design §4.1).
 *
 * It appears in exactly three places, each owned by a different surface: the
 * login window the Electron shell renders, the account card the settings client
 * renders, and the NSIS installer's branding line. Two dictionaries carry it —
 * English and Chinese — with the same text, because a vendor line is not
 * translated.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en as shellEn, zh as shellZh } from '../src/locale.ts'

/** Text every surface shows verbatim. */
const VENDOR_LINE = 'Powered by xdedmi'

describe('vendor line', () => {
  it('is the same in both shell dictionaries', () => {
    expect(shellEn.welcomePoweredBy).toBe(VENDOR_LINE)
    expect(shellZh.welcomePoweredBy).toBe(VENDOR_LINE)
  })

  it('is the same in both account dictionaries', () => {
    // Read as text: this spec belongs to the Host program, which does not include
    // Client package sources; the account component spec renders the card itself.
    const source = readFileSync(join(import.meta.dirname,
      '../../../packages/client/ui-settings-account/src/client/locales.ts'), 'utf8')
    expect(source.match(new RegExp(`poweredBy: '${VENDOR_LINE}'`, 'gu'))).toHaveLength(2)
  })

  it('is the NSIS installer branding line, and the uninstaller keeps its blank line', () => {
    const source = readFileSync(join(import.meta.dirname, '../scripts/installer.nsh'), 'utf8')
    expect(source).toContain(`BrandingText "${VENDOR_LINE}"`)
    // NSIS's own credit stays hidden in the uninstaller.
    expect(source).toContain('BrandingText " "')
  })

  it('reaches the login window and the account card from their dictionaries', () => {
    const welcome = readFileSync(join(import.meta.dirname, '../src/client/WelcomePage.tsx'), 'utf8')
    expect(welcome).toContain('m.welcomePoweredBy')
    const account = readFileSync(join(import.meta.dirname, '../../../packages/client/ui-settings-account/src/client/AccountSection.tsx'), 'utf8')
    // Both the signed-out prompt and the signed-in cards end with it.
    expect(account.match(/t\('poweredBy'\)/gu)).toHaveLength(2)
  })
})
