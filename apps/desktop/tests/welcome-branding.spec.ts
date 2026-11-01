/**
 * The Hub build must not present the upstream product as the thing a user signs
 * into. This test reads the shell dictionaries the welcome window and the menus
 * render, applies the same branding the packaged bundle applies, and fails on an
 * upstream product or account name in any welcome string.
 *
 * It exists because the copy is data: a rebase can restore an upstream string
 * without any TypeScript error, and the first thing a new desktop user reads is
 * this window.
 */

import { describe, expect, it } from 'vitest'
import { brandedWelcomeMessages } from './hub-connector/welcome-branding.ts'
import { brandDesktopMessages, DESKTOP_BRANDING } from '../src/branding.ts'
import { en, zh } from '../src/locale.ts'

/** The dictionary the packaged shell hands to the welcome renderer. */
const branded = { en: brandedWelcomeMessages(en), zh: brandedWelcomeMessages(zh) }

describe('welcome copy in a Hub build', () => {
  it('names DSH Hub on the sign-in button and never the upstream account', () => {
    expect(branded.en.welcomeSignIn).toBe('Log in to DSH Hub')
    expect(branded.zh.welcomeSignIn).toBe('登录 DSH Hub')
  })

  it('carries no upstream product or account name in any welcome string', () => {
    for (const [locale, messages] of Object.entries(branded)) {
      for (const [key, value] of Object.entries(messages)) {
        if (!key.startsWith('welcome')) continue
        // A source run keeps the upstream name in DESKTOP_BRANDING (the bundle inlines
        // the Hub one), so the window title is checked through the account copy instead.
        if (key === 'welcomeTitle' || key === 'welcomeBrand' || key === 'welcomeTaglineBrand') continue
        expect(value, `${locale}.${key}`).not.toMatch(/DeepSeek/iu)
      }
    }
  })

  it('routes the product name through branding rather than hardcoding it', () => {
    // The packaged bundle inlines the Hub identity; every dictionary consumer calls
    // brandDesktopMessages, so one value moves the whole window.
    const messages = brandDesktopMessages(en)
    expect(messages.welcomeTitle).toBe(DESKTOP_BRANDING.productName)
    expect(messages.welcomeBrand).toBe(DESKTOP_BRANDING.productName)
    expect(messages.welcomeTaglineBrand).toBe(DESKTOP_BRANDING.productName)
  })
})
