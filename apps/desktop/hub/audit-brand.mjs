#!/usr/bin/env node
/**
 * Reject upstream DeepSeek branding that reaches a DSH Hub user interface.
 *
 * The Hub build ships a product called DSH Hub, so a user-visible string that
 * names the upstream product (`DeepSeek Harness`, `deepseek HARNESS`, the
 * `深度求索` company name) or links to an upstream site is a branding defect, not
 * a translation. This check reads the two places such text lives:
 *
 * - **Dictionary sources** (default, and the assertion `hub-build.sh` runs):
 *   every string literal under `packages/client/*\/src/client`, the Electron
 *   shell's message table, and the package metadata the plugin manager renders.
 * - **Build artifacts** (`--artifacts <dir>`, run by `hub-build.sh` on the
 *   packaged app): the client bundles of the packages the Hub composition
 *   actually loads, so an inlined copy cannot slip through.
 *
 * Model names (`DeepSeek-V4.1-Flash`), real service endpoints the official
 * provider needs, and strings in packages the Hub composition disables are not
 * defects. They are listed in `brand-audit-allow.json` with a reason, and every
 * entry claiming a disabled row is checked against the Hub bundle layers, so an
 * allowlist entry cannot outlive the composition it describes.
 *
 *   node apps/desktop/hub/audit-brand.mjs
 *   node apps/desktop/hub/audit-brand.mjs --artifacts <win-unpacked>/resources/dsh
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** Repository root, resolved from this file so the script runs from any cwd. */
const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

/** Allowlist carrying the classification of every accepted upstream mention. */
export const ALLOWLIST_PATH = 'apps/desktop/hub/brand-audit-allow.json'

/** Bundle layers the Hub composes on top of the Web app; their `disabled` rows are authoritative. */
const HUB_BUNDLE_PATCHES = [
  'apps/desktop/hub/plugins/hub-brand/cordis.patch.yml',
  'apps/desktop/hub/plugins/hub-connector/cordis.patch.yml',
]

/** The Web app bundle declares every client row's package name. */
const WEB_BUNDLE_PATCH = 'packages/bundle/web-app/cordis.patch.yml'

/** Product-name phrases no DSH Hub surface may show, in source and in artifacts. */
const PRODUCT_NAME_PATTERN = /DeepSeek\s+Harness|deepseek\s+HARNESS|深度求索/u

/** Every upstream mention, for the source scan. */
const ANY_MENTION = /DeepSeek|deepseek|深度求索|Harness/u

/** Files whose copy the Electron shell brand-substitutes at load. */
const SHELL_MESSAGE_TABLE = 'apps/desktop/src/locale.ts'

/** Product name the shell substitutes in that table; the only literal it may contain. */
const SHELL_SUBSTITUTED = 'DeepSeek Harness'

/** One accepted upstream mention and why it is not a branding defect. */
export class AuditError extends Error {}

/**
 * Read one allowlist file.
 * @param root - Repository root.
 * @returns Parsed allowlist entries.
 * @throws {AuditError} When the file is missing or malformed.
 */
export function readAllowlist(root) {
  const path = join(root, ALLOWLIST_PATH)
  if (!existsSync(path)) throw new AuditError(`brand audit: ${ALLOWLIST_PATH} is missing`)
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.entries)) {
    throw new AuditError(`brand audit: ${ALLOWLIST_PATH} must hold an entries array`)
  }
  return parsed.entries
}

/**
 * Collect the copy a dictionary file owns: the string values of its property
 * assignments. Keys, module specifiers, `declare module` names, and service or
 * event identifiers are code, never copy, and are not returned.
 * @param text - File content.
 * @returns Literal text with its one-based line number.
 */
export function dictionaryValues(text) {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const values = []
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const value = node.initializer
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
        const line = source.getLineAndCharacterOfPosition(value.getStart(source)).line + 1
        values.push({ text: value.text, line })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return values
}

/** Whether a client source file owns copy: the dictionary files and their folders. */
function isDictionaryFile(relativePath) {
  const parts = relativePath.split('/')
  const name = parts.at(-1) ?? ''
  if (name === 'locale.ts' || name === 'locales.ts') return true
  return parts.includes('locales') || parts.includes('locale')
}

/**
 * Recursively list files under one directory with a matching extension.
 * @param directory - Absolute directory.
 * @param extension - File suffix to keep.
 * @returns Absolute paths in sorted order.
 */
function filesUnder(directory, extension) {
  const found = []
  if (!existsSync(directory)) return found
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) found.push(...filesUnder(path, extension))
    else if (name.endsWith(extension)) found.push(path)
  }
  return found
}

/**
 * Every client dictionary and client source file the source scan reads.
 * @param root - Repository root.
 * @returns Repository-relative paths.
 */
export function sourceScanFiles(root) {
  const files = []
  const clientRoot = join(root, 'packages', 'client')
  if (existsSync(clientRoot)) {
    for (const group of readdirSync(clientRoot).sort()) {
      const sources = join(clientRoot, group, 'src', 'client')
      if (!existsSync(sources)) continue
      const candidates = [...filesUnder(sources, '.ts'), ...filesUnder(sources, '.tsx')]
      files.push(...candidates.filter(file => isDictionaryFile(relative(root, file).split('\\').join('/'))))
    }
  }
  const shell = join(root, SHELL_MESSAGE_TABLE)
  if (existsSync(shell)) files.push(shell)
  return [...new Set(files.map(file => relative(root, file).split('\\').join('/')))].sort()
}

/**
 * Package metadata files (title and description shown by the plugin manager).
 * @param root - Repository root.
 * @returns Repository-relative paths.
 */
export function metadataFiles(root) {
  const files = []
  const groups = join(root, 'packages')
  if (!existsSync(groups)) return files
  for (const group of readdirSync(groups).sort()) {
    if (group.startsWith('.')) continue
    const groupDirectory = join(root, 'packages', group)
    if (!statSync(groupDirectory).isDirectory()) continue
    for (const pkg of readdirSync(groupDirectory).sort()) {
      for (const locale of ['en.json', 'zh.json']) {
        const path = join(groupDirectory, pkg, 'locale', locale)
        if (existsSync(path)) files.push(relative(root, path).split('\\').join('/'))
      }
    }
  }
  const bundles = join(root, 'packages', 'bundle')
  if (existsSync(bundles)) {
    for (const bundle of readdirSync(bundles).sort()) {
      const path = join(bundles, bundle, 'locale', 'zh.json')
      if (existsSync(path)) files.push(relative(root, path).split('\\').join('/'))
    }
  }
  return files.sort()
}

/**
 * Whether an allowlist entry covers one hit.
 * @param entry - One allowlist entry.
 * @param hit - File, line, and text of the offending literal.
 * @returns True when the entry names this file and the literal contains its match.
 */
function entryCovers(entry, hit) {
  if (typeof entry.file !== 'string' || typeof entry.match !== 'string') return false
  if (entry.artifact === true) return false
  return entry.file === hit.file && hit.text.includes(entry.match)
}

/**
 * Collect the row ids the Hub bundle layers disable.
 * @param root - Repository root.
 * @returns Disabled row ids, and the patch file that disables each one.
 */
export function disabledRows(root) {
  const disabled = new Map()
  for (const relativePath of HUB_BUNDLE_PATCHES) {
    const path = join(root, relativePath)
    if (!existsSync(path)) continue
    let current
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
      const row = /^\s*-\s+id:\s*(\S+)\s*$/u.exec(line)
      if (row !== null) {
        current = row[1]
        continue
      }
      if (/^\s*disabled:\s*true\s*$/u.test(line) && current !== undefined) disabled.set(current, relativePath)
    }
  }
  return disabled
}

/**
 * Check every allowlist entry that claims a disabled row against the Hub patches.
 * @param root - Repository root.
 * @param entries - Allowlist entries.
 * @returns Problems; empty when every claim holds.
 */
export function allowlistProblems(root, entries) {
  const disabled = disabledRows(root)
  const problems = []
  for (const entry of entries) {
    if (entry.disabledRow === undefined) continue
    if (!disabled.has(entry.disabledRow)) {
      problems.push(`${ALLOWLIST_PATH}: "${String(entry.match)}" claims row "${String(entry.disabledRow)}" is disabled, but no Hub bundle layer disables it`)
    }
  }
  return problems
}

/**
 * Scan the dictionary sources for upstream mentions that are not classified.
 * @param root - Repository root.
 * @param entries - Allowlist entries.
 * @returns Violations as `file:line: text` strings.
 */
export function scanSources(root, entries) {
  const violations = []
  const report = []
  for (const file of sourceScanFiles(root)) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const literal of dictionaryValues(text)) {
      if (!ANY_MENTION.test(literal.text)) continue
      const hit = { file, line: literal.line, text: literal.text, category: 'source' }
      if (file === SHELL_MESSAGE_TABLE && literal.text.includes(SHELL_SUBSTITUTED)
        && !/(?:DeepSeek|deepseek|深度求索|Harness)/u.test(literal.text.replaceAll(SHELL_SUBSTITUTED, ''))) {
        report.push({ ...hit, classification: 'shell-substitution' })
        continue
      }
      const covering = entries.find(entry => entryCovers(entry, hit))
      if (covering === undefined) violations.push(hit)
      else report.push({ ...hit, classification: covering.category })
    }
  }
  // Product metadata describes installed plugins; the upstream product name is still
  // a defect there, while naming a DeepSeek service ("DeepSeek 网页搜索") is not.
  for (const file of metadataFiles(root)) {
    const values = JSON.parse(readFileSync(join(root, file), 'utf8'))
    const meta = values?.meta ?? {}
    for (const [field, value] of Object.entries(meta)) {
      if (typeof value !== 'string' || !PRODUCT_NAME_PATTERN.test(value)) continue
      violations.push({ file, line: 0, text: `${field}: ${value}`, category: 'metadata' })
    }
  }
  return { violations, report }
}

/**
 * Collect the client packages the Hub composition loads.
 * @param root - Repository root.
 * @returns Package names minus every row the Hub bundle layers disable.
 */
export function composedClientPackages(root) {
  const disabled = disabledRows(root)
  const packages = new Set()
  const patch = join(root, WEB_BUNDLE_PATCH)
  if (!existsSync(patch)) return packages
  let current
  for (const line of readFileSync(patch, 'utf8').split(/\r?\n/u)) {
    const row = /^\s*-\s+id:\s*(\S+)\s*$/u.exec(line)
    if (row !== null) {
      current = row[1]
      continue
    }
    const name = /^\s*name:\s*['"]?(\S+?)['"]?\s*$/u.exec(line)
    if (name !== null && current !== undefined && !disabled.has(current)) {
      packages.add(name[1])
      current = undefined
    }
  }
  return packages
}

/**
 * Scan built client bundles for the upstream product name.
 *
 * `directory` is one level of client packages — the repository's
 * `packages/client` after `build:artifacts`, or any tree of `dsh-client-*`
 * directories that each hold a `package.json` and `lib/client.js`. Only the
 * packages the Hub composition loads are read: a disabled row's bundle cannot
 * reach a user, so its copy is not this check's subject.
 * @param root - Repository root.
 * @param directory - Absolute directory whose children are client packages.
 * @returns Violations as `file: line` strings, and how many bundles were read.
 */
export function scanArtifacts(root, directory) {
  const packages = composedClientPackages(root)
  if (!existsSync(directory)) {
    return { violations: [`brand audit: no client packages under ${directory}`], bundles: 0 }
  }
  const violations = []
  let candidates = 0
  let bundles = 0
  for (const name of readdirSync(directory).sort()) {
    const manifest = join(directory, name, 'package.json')
    const bundle = join(directory, name, 'lib', 'client.js')
    if (!existsSync(manifest) || !existsSync(bundle)) continue
    candidates += 1
    const packageName = JSON.parse(readFileSync(manifest, 'utf8')).name
    if (typeof packageName !== 'string' || !packages.has(packageName)) continue
    bundles += 1
    const lines = readFileSync(bundle, 'utf8').split(/\r?\n/u)
    lines.forEach((line, index) => {
      if (!PRODUCT_NAME_PATTERN.test(line)) return
      violations.push(`${relative(root, bundle)}:${String(index + 1)}: ${line.trim().slice(0, 160)}`)
    })
  }
  if (candidates === 0) violations.push(`brand audit: ${directory} holds no built client bundle (lib/client.js); run build:artifacts first`)
  return { violations, bundles }
}

/** Read `--artifacts <dir>` out of the process arguments. */
function artifactsArgument(argv) {
  const index = argv.indexOf('--artifacts')
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new AuditError('brand audit: --artifacts needs a directory')
  return resolve(value)
}

function main(argv) {
  const entries = readAllowlist(ROOT)
  const problems = allowlistProblems(ROOT, entries)
  const { violations, report } = scanSources(ROOT, entries)
  for (const violation of violations) {
    problems.push(`${violation.file}:${String(violation.line)}: ${violation.text}`)
  }
  const artifacts = artifactsArgument(argv)
  let bundleCount = 0
  if (artifacts !== undefined) {
    const scanned = scanArtifacts(ROOT, artifacts)
    bundleCount = scanned.bundles
    for (const violation of scanned.violations) problems.push(violation)
  }
  if (problems.length > 0) {
    console.error(`audit-brand: ${String(problems.length)} unclassified upstream DeepSeek mention(s):`)
    for (const problem of problems) console.error(`  ${problem}`)
    console.error(`audit-brand: classify each one in ${ALLOWLIST_PATH} (category A must be replaced, B/C may be kept with a reason)`)
    process.exitCode = 1
    return
  }
  const kept = report.filter(hit => hit.classification !== 'shell-substitution').length
  process.stdout.write(`audit-brand: no unclassified upstream branding (${String(kept)} classified mention(s) in dictionaries, `
    + `${String(entries.length)} allowlist entr${entries.length === 1 ? 'y' : 'ies'}`
    + `${artifacts === undefined ? '' : `, ${String(bundleCount)} packaged client bundle(s)`})\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv)
  } catch (error) {
    if (error instanceof AuditError) {
      console.error(error.message)
      process.exitCode = 2
    } else {
      throw error
    }
  }
}
