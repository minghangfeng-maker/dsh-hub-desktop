/**
 * Account binding of the phone channel.
 *
 * The switch belongs to the machine, the binding belongs to the account. A
 * channel may only run while the stored binding names exactly the account and
 * device the current grant stands for, so switching accounts (or re-registering
 * the device after a Hub-side removal) can never inherit someone else's switch.
 */

import type { ChannelBinding, ChannelCredentials } from './types.ts'

/**
 * Reduce a Hub origin to scheme, host, and port.
 * @param origin - configured or granted Hub origin, possibly with a path or trailing slash.
 * @returns the origin, or '' when the value is not an absolute http(s) URL.
 */
export function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch {
    // A Hub origin that does not parse is not an origin this channel may reach.
    return ''
  }
}

/**
 * Record the account a switch applies to.
 * @param input - grant facts and the recording time.
 * @returns the binding to persist.
 */
export function createBinding(input: {
  readonly nodeId: string
  readonly username: string
  readonly hubOrigin: string
  readonly at: Date
}): ChannelBinding {
  return {
    nodeId: input.nodeId,
    username: input.username,
    hubOrigin: normalizeOrigin(input.hubOrigin),
    boundAt: input.at.toISOString(),
  }
}

/**
 * Whether a stored binding still describes the current grant.
 * @param binding - persisted binding, or null/undefined before the first one.
 * @param credentials - current grant facts.
 * @returns true only when node, account, and origin all agree.
 */
export function bindingMatches(
  binding: ChannelBinding | null | undefined,
  credentials: Pick<ChannelCredentials, 'nodeId' | 'username' | 'hubOrigin'>,
): boolean {
  if (binding === null || binding === undefined) return false
  return binding.nodeId === credentials.nodeId
    && binding.username === credentials.username
    && binding.hubOrigin === normalizeOrigin(credentials.hubOrigin)
}

/**
 * Read one persisted binding without trusting the file.
 * @param value - parsed JSON member.
 * @returns the binding, or undefined when any field is missing or malformed.
 */
export function parseBinding(value: unknown): ChannelBinding | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const nodeId = record.nodeId
  const username = record.username
  const hubOrigin = record.hubOrigin
  const boundAt = record.boundAt
  if (typeof nodeId !== 'string' || nodeId === '') return undefined
  if (typeof username !== 'string' || username === '') return undefined
  if (typeof hubOrigin !== 'string' || normalizeOrigin(hubOrigin) !== hubOrigin) return undefined
  if (typeof boundAt !== 'string' || Number.isNaN(Date.parse(boundAt))) return undefined
  return { nodeId, username, hubOrigin, boundAt }
}
