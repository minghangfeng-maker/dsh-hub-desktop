/**
 * The Hub overlay file and the settings the desktop shell reads from it.
 *
 * The overlay is a Cordis patch list the desktop Host applies last, so a Hub
 * manifest can outrank every profile and bundle layer. The shell also needs two
 * settings before the Host exists — the proxy policy the agent inherits and,
 * later, the Hub origin — so the overlay reserves a commented block for them:
 * the Loader ignores comments, and the shell reads nothing else from the file.
 * The Hub connector owns the block once it delivers configuration; the shell only
 * reads it.
 *
 *   # hubProxy.http=http://corp.example:8080
 *   # hubProxy.https=http://corp.example:8080
 *   # hubProxy.noProxy=localhost,.corp.example
 */

import { existsSync, readFileSync } from 'node:fs'

/** Hub-managed overlay file in the desktop profile directory. */
export const HUB_OVERLAY_FILENAME = 'cordis.hub.patch.yml'

/** Proxy policy a Hub manifest delivered, to outrank the operating system's own. */
export interface HubProxyOverride {
  /** HTTP proxy URL. */
  readonly http?: string | undefined
  /** HTTPS proxy URL. */
  readonly https?: string | undefined
  /** `NO_PROXY` value, already in its comma-separated form. */
  readonly noProxy?: string | undefined
}

/** Result of reading the reserved settings block. */
export interface HubOverlaySettings {
  /** Proxy policy the overlay delivered, when it delivered one. */
  readonly proxy?: HubProxyOverride | undefined
  /** Diagnostics about the block: unknown keys, unusable values, read failures. */
  readonly diagnostics: readonly string[]
}

/** Expression matching one reserved setting line. */
const SETTING = /^#\s*hubProxy\.(http|https|noProxy)\s*=\s*(\S.*?)\s*$/u

/** Reject a proxy URL that the environment consumer could not use. */
function proxyUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString().replace(/\/$/u, '')
  } catch {
    return undefined
  }
}

/**
 * Read the proxy policy the Hub overlay reserves.
 * @param profile - Desktop profile directory.
 * @returns The delivered policy, or diagnostics when the file is absent or a value is unusable.
 */
export function readHubOverlaySettings(profile: string): HubOverlaySettings {
  const path = `${profile}/${HUB_OVERLAY_FILENAME}`
  if (!existsSync(path)) return { diagnostics: [] }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { diagnostics: [`desktop hub overlay: could not read ${path}: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const diagnostics: string[] = []
  const values: { http?: string; https?: string; noProxy?: string } = {}
  for (const line of text.split(/\r?\n/u)) {
    const match = SETTING.exec(line)
    if (match === null) continue
    const key = match[1] as 'http' | 'https' | 'noProxy'
    const raw = match[2] ?? ''
    if (key === 'noProxy') {
      values.noProxy = raw
      continue
    }
    const url = proxyUrl(raw)
    if (url === undefined) {
      diagnostics.push(`desktop hub overlay: ignoring hubProxy.${key} ${JSON.stringify(raw)} because it is not an HTTP proxy URL`)
      continue
    }
    values[key] = url
  }
  if (values.http === undefined && values.https === undefined && values.noProxy === undefined) return { diagnostics }
  return { proxy: { ...values }, diagnostics }
}
