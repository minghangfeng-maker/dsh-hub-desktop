/**
 * The Hub plugin archive must carry its declared runtime dependencies.
 *
 * The profile unpacks a Hub plugin without a package manager, so a dependency the
 * connector bundles has to be inside the archive. A regression here ships a plugin
 * whose adapter cannot be loaded, which shows up only on a user's machine.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { pluginFiles } from '../../scripts/hub-plugin-archive.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Build one plugin directory with the files the archive keeps. */
function plugin(options: {
  readonly bundleDependencies?: readonly string[]
  readonly modules?: Record<string, string>
}): string {
  const root = mkdtempSync(join(tmpdir(), 'hub-plugin-archive-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@dsh-hub/fixture',
    version: '0.0.0',
    ...options.bundleDependencies === undefined ? {} : { bundleDependencies: options.bundleDependencies },
  }))
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'lib', 'index.js'), 'export {}\n')
  for (const [path, contents] of Object.entries(options.modules ?? {})) {
    const target = join(root, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, contents)
  }
  return root
}

it('carries every declared bundled dependency and nothing else from node_modules', () => {
  const root = plugin({
    bundleDependencies: ['@dsh-hub/adapter', 'ws'],
    modules: {
      'node_modules/@dsh-hub/adapter/package.json': '{"name":"@dsh-hub/adapter"}',
      'node_modules/@dsh-hub/adapter/dist/index.js': 'export const a = 1\n',
      'node_modules/ws/package.json': '{"name":"ws"}',
      'node_modules/ws/index.js': 'export const ws = 1\n',
      'node_modules/dev-only/package.json': '{"name":"dev-only"}',
    },
  })
  const paths = pluginFiles(root).map(entry => entry.path)
  expect(paths).toContain('package/node_modules/@dsh-hub/adapter/dist/index.js')
  expect(paths).toContain('package/node_modules/ws/index.js')
  expect(paths).toContain('package/lib/index.js')
  expect(paths.some(path => path.includes('dev-only'))).toBe(false)
})

it('fails the build when a declared dependency is not installed', () => {
  const root = plugin({
    bundleDependencies: ['@dsh-hub/adapter', 'ws'],
    modules: { 'node_modules/ws/package.json': '{"name":"ws"}', 'node_modules/ws/index.js': 'export {}\n' },
  })
  expect(() => pluginFiles(root)).toThrow(/@dsh-hub\/adapter/u)
})

it('keeps node_modules out entirely when nothing is declared', () => {
  const root = plugin({ modules: { 'node_modules/ws/package.json': '{"name":"ws"}' } })
  const paths = pluginFiles(root).map(entry => entry.path)
  expect(paths.some(path => path.includes('node_modules'))).toBe(false)
  expect(paths).toContain('package/lib/index.js')
})
