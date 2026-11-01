/**
 * Retry schedule of the outbound channel.
 *
 * One schedule for every connection: exponential base capped at
 * {@link MAX_RETRY_MS}, halved by jitter so a fleet of machines that lost the
 * Hub together does not reconnect in lockstep.
 */

/** Delay of the first retry, before jitter. */
export const MIN_RETRY_MS = 1_000

/** Ceiling every retry delay stays under. */
export const MAX_RETRY_MS = 30_000

/**
 * Delay before one retry attempt.
 * @param attempt - zero-based failed-attempt index.
 * @param random - uniform value in `[0, 1)`; supplied so tests are deterministic.
 * @returns milliseconds in `[base/2, base]`, where `base` is the capped exponential.
 */
export function retryDelay(attempt: number, random: number): number {
  const index = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0
  const base = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.min(index, 16))
  const jitter = Math.min(1, Math.max(0, random))
  return Math.round(base * (0.5 + jitter * 0.5))
}

/**
 * Convert one millisecond delay into an absolute ISO-8601 instant.
 * @param now - current time.
 * @param delayMs - delay already chosen.
 * @returns ISO-8601 timestamp of the retry.
 */
export function retryAt(now: Date, delayMs: number): string {
  return new Date(now.getTime() + delayMs).toISOString()
}
