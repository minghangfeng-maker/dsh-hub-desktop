/**
 * The connector writes a handful of lines to the Host's stdout: the desktop
 * Host installs no logger exporter, and the application log is where an
 * operator reads why a device did or did not reach the Hub. Diagnostics stay
 * content-free — a report, a password, and a token never reach a line.
 */

/** Every line carries this prefix so the application log stays greppable. */
export const PREFIX = 'hub-connector'

/**
 * Write one informational line.
 * @param message - Operator-facing text; never contains credentials or user content.
 */
export function info(message: string): void {
  console.info(`${PREFIX}: ${message}`)
}

/**
 * Write one warning line.
 *
 * The desktop Host forwards the child's stdout to the application log and keeps
 * stderr in memory until the Host fails, so a warning written to stderr would be
 * invisible exactly when an operator needs it. Warnings therefore share the
 * stdout channel and carry their own level marker.
 * @param message - Operator-facing text; never contains credentials or user content.
 */
export function warn(message: string): void {
  console.info(`${PREFIX}: warning: ${message}`)
}

/**
 * Write one failure line.
 * @param message - Operator-facing text; never contains credentials or user content.
 * @param error - Caught value whose message (not stack) is appended.
 */
export function failure(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  console.info(`${PREFIX}: failure: ${message}: ${detail}`)
}

/**
 * Reduce a URL to its origin for logging.
 * @param url - URL to describe.
 * @returns The origin, or the input when it does not parse as an absolute URL.
 */
export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return '<invalid-url>'
  }
}
