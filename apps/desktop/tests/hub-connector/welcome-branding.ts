/**
 * The welcome dictionary a Hub build renders.
 *
 * Branding already replaces the upstream product name in every shell string, but
 * the account vocabulary ("official DeepSeek models", "sign in") is product copy,
 * not a name: it has to be replaced here so the gate a new user meets describes
 * the DSH Hub account it actually signs into.
 */

import type { DesktopMessages } from '../../src/locale.ts'

/** Copy this build replaces, keyed by the dictionary key. */
const HUB_WELCOME_COPY: Readonly<Partial<Record<keyof DesktopMessages, string>>> = {
  welcomeSignIn: 'Log in to DSH Hub',
  welcomeAuthStarting: 'Opening the DSH Hub sign-in page…',
  welcomeKeyDescription: 'A DSH Hub account brings its own models; an API key is the offline fallback',
}

/** Chinese copy this build replaces. */
const HUB_WELCOME_COPY_ZH: Readonly<Partial<Record<keyof DesktopMessages, string>>> = {
  welcomeSignIn: '登录 DSH Hub',
  welcomeAuthStarting: '正在打开 DSH Hub 登录页…',
  welcomeKeyDescription: 'DSH Hub 账号自带模型；API Key 是离线兜底',
}

/**
 * Overlay the Hub wording on one shell dictionary.
 * @param messages - Dictionary after product-name branding.
 * @returns The dictionary with the Hub account copy applied.
 */
export function brandedWelcomeMessages(messages: DesktopMessages): DesktopMessages {
  const zh = messages.welcomeSignIn.includes('登录')
  return { ...messages, ...(zh ? HUB_WELCOME_COPY_ZH : HUB_WELCOME_COPY) }
}
