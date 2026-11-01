import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allowlistProblems, composedClientPackages, dictionaryValues, readAllowlist, scanArtifacts, scanSources, sourceScanFiles,
} from '../hub/audit-brand.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const temporaryRoots: string[] = []

/** Create one disposable repository-shaped root. */
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-audit-brand-'))
  temporaryRoots.push(root)
  return root
}

/** Write one file, creating its parents. */
function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** The Hub bundle layer a disabled-row claim is checked against. */
const HUB_PATCH = 'apps/desktop/hub/plugins/hub-connector/cordis.patch.yml'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('dictionary value extraction', () => {
  it('returns the values a dictionary owns and never its keys or module specifiers', () => {
    const values = dictionaryValues([
      "import type {} from '@deepseek-ai/dsh-client-ui-slots'",
      "declare module '@deepseek-ai/cordis' { interface Context {} }",
      'export const en = {',
      "  greeting: 'Hello',",
      "  'chat.deepDiving': 'Deep diving',",
      '  ignored: register(\'deepseek-account\'),',
      '}',
    ].join('\n'))
    expect(values.map(value => value.text)).toEqual(['Hello', 'Deep diving'])
  })

  it('reports one-based line numbers', () => {
    expect(dictionaryValues('\n\nconst en = { a: \'b\' }\n')[0]?.line).toBe(3)
  })
})

describe('branding scan', () => {
  it('passes on this checkout', () => {
    const scan = scanSources(ROOT, readAllowlist(ROOT))
    expect(scan.violations).toEqual([])
    expect(scan.report.length).toBeGreaterThan(0)
  })

  it('fails on this checkout when the allowlist is empty', () => {
    expect(scanSources(ROOT, []).violations.length).toBeGreaterThan(0)
  })

  it('reads the client dictionaries and the shell message table', () => {
    const files = sourceScanFiles(ROOT)
    expect(files).toContain('apps/desktop/src/locale.ts')
    expect(files).toContain('packages/client/ui-settings-account/src/client/locales.ts')
    for (const file of files) expect(readFileSync(join(ROOT, file), 'utf8').length).toBeGreaterThan(0)
  })

  it('fails on a product name a dictionary carries and no entry classifies', () => {
    const root = temporaryRoot()
    write(root, 'packages/client/demo/src/client/locales.ts', "export const en = { backToHarness: 'Back to DeepSeek Harness' }\n")
    const scan = scanSources(root, [])
    expect(scan.violations).toHaveLength(1)
    expect(scan.violations[0]).toMatchObject({ file: 'packages/client/demo/src/client/locales.ts', line: 1 })
  })

  it('accepts a mention an entry classifies for that file', () => {
    const root = temporaryRoot()
    write(root, 'packages/client/demo/src/client/locales.ts', "export const en = { endpoint: 'https://api.deepseek.com/anthropic' }\n")
    const entries = [{
      file: 'packages/client/demo/src/client/locales.ts',
      match: 'https://api.deepseek.com/anthropic',
      category: 'B' as const,
      reason: 'official provider endpoint',
    }]
    expect(scanSources(root, entries).violations).toEqual([])
  })

  it('never accepts the shell brand-substitution token outside the shell table', () => {
    const root = temporaryRoot()
    write(root, 'apps/desktop/src/locale.ts', "export const en = { about: 'About DeepSeek Harness' }\n")
    write(root, 'packages/client/demo/src/client/locales.ts', "export const en = { about: 'About DeepSeek Harness' }\n")
    const scan = scanSources(root, [])
    expect(scan.violations.map(hit => hit.file)).toEqual(['packages/client/demo/src/client/locales.ts'])
    expect(scan.report.map(hit => hit.classification)).toContain('shell-substitution')
  })

  it('accepts a shell message that substitutes the product name and nothing else', () => {
    const root = temporaryRoot()
    write(root, 'apps/desktop/src/locale.ts', [
      "export const en = { about: 'About DeepSeek Harness' }",
      "export const zh = { account: 'DeepSeek 账号' }",
    ].join('\n'))
    const violations = scanSources(root, []).violations
    expect(violations).toHaveLength(1)
    expect(violations[0]?.text).toBe('DeepSeek 账号')
  })

  it('fails on a product name in package metadata the plugin manager renders', () => {
    const root = temporaryRoot()
    write(root, 'packages/llm/demo/locale/zh.json', JSON.stringify({ meta: { title: 'DeepSeek Harness 适配' } }))
    const scan = scanSources(root, [])
    expect(scan.violations).toEqual([{ file: 'packages/llm/demo/locale/zh.json', line: 0, text: 'title: DeepSeek Harness 适配', category: 'metadata' }])
  })

  it('leaves a service name in package metadata alone', () => {
    const root = temporaryRoot()
    write(root, 'packages/web/demo/locale/zh.json', JSON.stringify({ meta: { title: 'DeepSeek 网页搜索' } }))
    expect(scanSources(root, []).violations).toEqual([])
  })
})

describe('disabled-row claims', () => {
  it('accepts a claim the Hub bundle layer backs', () => {
    const root = temporaryRoot()
    write(root, HUB_PATCH, ['- id: ui-settings-demo', '  disabled: true', ''].join('\n'))
    const entries = [{ file: 'a.ts', match: 'DeepSeek', category: 'C' as const, reason: 'r', disabledRow: 'ui-settings-demo' }]
    expect(allowlistProblems(root, entries)).toEqual([])
  })

  it('fails once the Hub bundle layer stops disabling the row', () => {
    const root = temporaryRoot()
    write(root, HUB_PATCH, ['- id: ui-settings-demo', '  disabled: false', ''].join('\n'))
    const entries = [{ file: 'a.ts', match: 'DeepSeek', category: 'C' as const, reason: 'r', disabledRow: 'ui-settings-demo' }]
    expect(allowlistProblems(root, entries).join(' ')).toContain('ui-settings-demo')
  })

  it('keeps every allowlist claim in this checkout true', () => {
    expect(allowlistProblems(ROOT, readAllowlist(ROOT))).toEqual([])
  })
})

describe('packaged artifacts', () => {
  it('reads the composed client rows and honours the Hub disables', () => {
    const root = temporaryRoot()
    write(root, 'packages/bundle/web-app/cordis.patch.yml', [
      '- insert:',
      '    - id: ui-kept',
      "      name: '@deepseek-ai/dsh-client-kept'",
      '    - id: ui-removed',
      "      name: '@deepseek-ai/dsh-client-removed'",
      '',
    ].join('\n'))
    write(root, HUB_PATCH, ['- id: ui-removed', '  disabled: true', ''].join('\n'))
    expect([...composedClientPackages(root)]).toEqual(['@deepseek-ai/dsh-client-kept'])
  })

  it('fails on a product name inside a composed client bundle', () => {
    const root = temporaryRoot()
    write(root, 'packages/bundle/web-app/cordis.patch.yml', [
      '- insert:',
      '    - id: ui-kept',
      "      name: '@deepseek-ai/dsh-client-kept'",
      '',
    ].join('\n'))
    const artifacts = join(root, 'client-packages')
    write(root, 'client-packages/kept/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-client-kept' }))
    write(root, 'client-packages/kept/lib/client.js', "var copy = 'Welcome to DeepSeek Harness'\n")
    const scanned = scanArtifacts(root, artifacts)
    expect(scanned.bundles).toBe(1)
    expect(scanned.violations.join(' ')).toContain('DeepSeek Harness')
  })

  it('skips a bundle whose row the Hub layer disables', () => {
    const root = temporaryRoot()
    write(root, 'packages/bundle/web-app/cordis.patch.yml', [
      '- insert:',
      '    - id: ui-removed',
      "      name: '@deepseek-ai/dsh-client-removed'",
      '',
    ].join('\n'))
    write(root, HUB_PATCH, ['- id: ui-removed', '  disabled: true', ''].join('\n'))
    const artifacts = join(root, 'client-packages')
    write(root, 'client-packages/removed/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-client-removed' }))
    write(root, 'client-packages/removed/lib/client.js', "var copy = 'DeepSeek Harness'\n")
    const scanned = scanArtifacts(root, artifacts)
    expect(scanned.bundles).toBe(0)
    expect(scanned.violations).toEqual([])
  })

  it('fails when the directory is absent', () => {
    const root = temporaryRoot()
    const scanned = scanArtifacts(root, join(root, 'missing'))
    expect(scanned.violations.join(' ')).toContain('no client packages under')
  })

  it('fails when the directory holds no built client bundle', () => {
    const root = temporaryRoot()
    const empty = join(root, 'client-packages')
    mkdirSync(empty, { recursive: true })
    const scanned = scanArtifacts(root, empty)
    expect(scanned.violations.join(' ')).toContain('run build:artifacts first')
  })
})
