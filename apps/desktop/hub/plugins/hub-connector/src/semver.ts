/**
 * The version arithmetic the manifest needs, without a semver package.
 *
 * The connector resolves only Node builtins at runtime (the profile unpacks this
 * package without a package manager), so `semver` cannot be imported. Two
 * questions are asked of a version string here: is it a version this build can
 * parse, and does it fall inside the range a plugin or the Hub declares. Ranges
 * are the common subset DSH compositions use — caret, tilde, comparators joined
 * by spaces, and `||` alternatives.
 */

/** One parsed semantic version. */
export interface Semver {
  /** Major number. */
  readonly major: number
  /** Minor number. */
  readonly minor: number
  /** Patch number. */
  readonly patch: number
  /** Pre-release identifiers, empty for a release. */
  readonly prerelease: readonly string[]
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

/**
 * Parse one version.
 * @param value - Version text such as `0.2.1-rc.2`.
 * @returns The parsed version, or undefined when the text is not semantic.
 */
export function parseSemver(value: string): Semver | undefined {
  const match = SEMVER.exec(value.trim())
  if (match === null) return undefined
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

/** Compare two pre-release identifier lists by the semver precedence rules. */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 0
  // A release outranks every pre-release of the same triple.
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const numericA = /^\d+$/u.test(a)
    const numericB = /^\d+$/u.test(b)
    if (numericA && numericB) return Number(a) < Number(b) ? -1 : 1
    if (numericA) return -1
    if (numericB) return 1
    return a < b ? -1 : 1
  }
  return 0
}

/**
 * Order two versions by precedence.
 * @param left - First version.
 * @param right - Second version.
 * @returns Negative when `left` is lower, positive when higher, zero when equal.
 */
export function compareSemver(left: Semver, right: Semver): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** One comparator clause: an operator plus the version it names. */
interface Comparator {
  readonly operator: '>' | '>=' | '<' | '<=' | '='
  readonly version: Semver
}

/** Build the comparators one range token expands to. */
function comparatorsOf(token: string): Comparator[] | undefined {
  const trimmed = token.trim()
  if (trimmed === '' || trimmed === '*' || trimmed === 'x') return []
  const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/u.exec(trimmed)
  if (match === null) return undefined
  const operator = match[1] ?? '='
  const version = parseSemver(match[2] ?? '')
  if (version === undefined) return undefined
  if (operator === '^') {
    const upper: Semver = version.major > 0
      ? { major: version.major + 1, minor: 0, patch: 0, prerelease: [] }
      : version.minor > 0
        ? { major: 0, minor: version.minor + 1, patch: 0, prerelease: [] }
        : { major: 0, minor: 0, patch: version.patch + 1, prerelease: [] }
    return [{ operator: '>=', version }, { operator: '<', version: upper }]
  }
  if (operator === '~') {
    const upper: Semver = { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] }
    return [{ operator: '>=', version }, { operator: '<', version: upper }]
  }
  return [{ operator: operator as Comparator['operator'], version }]
}

/**
 * Test one version against a range.
 * @param value - Version to test.
 * @param range - Range text such as `>=0.2.1-rc.2 <0.3.0` or `^0.2.1 || ^0.3.0`.
 * @returns Whether the version satisfies the range; an unparsable range fails closed.
 */
export function satisfies(value: string, range: string): boolean {
  const version = parseSemver(value)
  if (version === undefined) return false
  const alternatives = range.split('||')
  return alternatives.some((alternative) => {
    const tokens = alternative.trim().split(/\s+/u)
    let sawToken = false
    for (const token of tokens) {
      if (token === '') continue
      const comparators = comparatorsOf(token)
      if (comparators === undefined) return false
      sawToken = true
      for (const comparator of comparators) {
        const order = compareSemver(version, comparator.version)
        const pass = comparator.operator === '>=' ? order >= 0
          : comparator.operator === '<=' ? order <= 0
            : comparator.operator === '>' ? order > 0
              : comparator.operator === '<' ? order < 0
                : order === 0
        if (!pass) return false
      }
    }
    return sawToken || version !== undefined
  })
}
