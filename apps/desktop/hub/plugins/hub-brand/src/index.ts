/**
 * Host half of the DSH Hub brand plugin.
 *
 * The browser half ships through `exports["./client"]`, which is what the
 * client module system serves; the Loader still needs a Host row so the package
 * is part of the profile composition and its client bundle enters the boot
 * graph. This half therefore contributes nothing of its own.
 */

/** Host plugin body: this package contributes browser presentation only. */
export function apply(): void {}
