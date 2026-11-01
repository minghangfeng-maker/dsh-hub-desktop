import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { readDesktopSettings, writeDesktopSettings } from '../src/settings.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

function fixture() {
  const userData = mkdtempSync(join(tmpdir(), 'dsh-desktop-settings-'))
  onTestFinished(() => { rmSync(userData, { recursive: true, force: true }) })
  const directory = join(userData, 'desktop')
  mkdirSync(directory)
  return { userData, path: join(directory, 'settings.json') }
}

it('creates a discoverable default file on first launch without touching other preferences', () => {
  const { userData, path } = fixture()
  rmSync(join(userData, 'desktop'), { recursive: true })
  writeFileSync(join(userData, 'keybindings.json'), 'existing shortcuts\n')
  expect(readDesktopSettings(userData)).toEqual({
    updates: { allowTestAuthPopupWindow: false },
    welcome: { offline: false },
    runtime: { pythonUtf8: true },
  })
  expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify({
    updates: { allowTestAuthPopupWindow: false },
    welcome: { offline: false },
    runtime: { pythonUtf8: true },
  }, null, 2)}\n`)
  expect(readFileSync(join(userData, 'keybindings.json'), 'utf8')).toBe('existing shortcuts\n')
})

it.each(['{}', '{"updates": {}}', '{"other": 1, "updates": {"other": true}}'])('defaults an older document without rewriting it: %s', (raw) => {
  const { userData, path } = fixture()
  writeFileSync(path, raw)
  expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(false)
  expect(readDesktopSettings(userData).welcome.offline).toBe(false)
  expect(readDesktopSettings(userData).runtime.pythonUtf8).toBe(true)
  expect(readFileSync(path, 'utf8')).toBe(raw)
})

it('loads explicit opt-in and opt-out on the next read without changing an earlier process snapshot', () => {
  const { userData, path } = fixture()
  for (const allow of [true, false]) {
    const raw = JSON.stringify({ updates: { allowTestAuthPopupWindow: allow }, custom: 'preserve' })
    writeFileSync(path, raw)
    expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(allow)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  }
  const previous = readDesktopSettings(userData)
  writeFileSync(path, '{"updates":{"allowTestAuthPopupWindow":true}}')
  expect(previous.updates.allowTestAuthPopupWindow).toBe(false)
  expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(true)
})

it.each(['', '{', 'null', '[]', '{"updates":null}', '{"updates":[]}', '{"welcome":null}', '{"welcome":[]}',
  '{"runtime":[]}', '{"updates":{"allowTestAuthPopupWindow":"false"}}', '{"updates":{"allowTestAuthPopupWindow":1}}',
  '{"updates":{"allowTestAuthPopupWindow":null}}', '{"welcome":{"offline":"true"}}', '{"welcome":{"offline":1}}',
  '{"runtime":{"pythonUtf8":"true"}}', '{"runtime":{"pythonUtf8":1}}'])('reports invalid settings with their path and preserves the original: %s', (raw) => {
  const { userData, path } = fixture()
  writeFileSync(path, raw)
  expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(false)
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error))
  expect(readFileSync(path, 'utf8')).toBe(raw)
})

it('reports filesystem errors instead of replacing unreadable settings', () => {
  const { userData, path } = fixture()
  mkdirSync(path)
  expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(false)
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error))
  expect(fs.statSync(path).isDirectory()).toBe(true)
})

it.each(['mkdirSync', 'writeFileSync'] as const)('continues with disabled popups when %s fails', (operation) => {
  const { userData, path } = fixture()
  const failure = Object.assign(new Error('settings creation denied'), { code: 'EACCES' })
  vi.spyOn(fs, operation).mockImplementation(() => { throw failure })
  expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(false)
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), failure)
})

it('continues with defaults even when warning output fails', () => {
  const { userData, path } = fixture()
  writeFileSync(path, '{')
  vi.mocked(console.warn).mockImplementation(() => { throw new Error('output unavailable') })
  expect(readDesktopSettings(userData).updates.allowTestAuthPopupWindow).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe('{')
})

it('writes the offline choice atomically and keeps keys and fields it does not own', () => {
  const { userData, path } = fixture()
  writeFileSync(path, JSON.stringify({ updates: { allowTestAuthPopupWindow: true, custom: 'keep' }, custom: 'preserve' }))
  const settings = readDesktopSettings(userData)
  writeDesktopSettings(userData, { ...settings, welcome: { offline: true } })
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    updates: { allowTestAuthPopupWindow: true, custom: 'keep' },
    welcome: { offline: true },
    runtime: { pythonUtf8: true },
    custom: 'preserve',
  })
  expect(readDesktopSettings(userData).welcome.offline).toBe(true)
  expect(readFileSync(path, 'utf8').endsWith('}\n')).toBe(true)
})

it('creates the settings document on the first write', () => {
  const { userData, path } = fixture()
  rmSync(join(userData, 'desktop'), { recursive: true })
  const next = { updates: { allowTestAuthPopupWindow: false }, welcome: { offline: true }, runtime: { pythonUtf8: true } }
  writeDesktopSettings(userData, next)
  expect(readDesktopSettings(userData).welcome.offline).toBe(true)
  expect(readFileSync(path, 'utf8')).toContain('"offline": true')
})

it('replaces an unreadable document and leaves no temporary file behind', () => {
  const { userData, path } = fixture()
  writeFileSync(path, '{not json')
  const next = { updates: { allowTestAuthPopupWindow: false }, welcome: { offline: true }, runtime: { pythonUtf8: true } }
  writeDesktopSettings(userData, next)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ welcome: { offline: true } })
  expect(fs.readdirSync(join(userData, 'desktop'))).toEqual(['settings.json'])
})

it('fails loudly when the replacement cannot complete and keeps the previous document', () => {
  const { userData, path } = fixture()
  const previous = JSON.stringify({ welcome: { offline: false } })
  writeFileSync(path, previous)
  const failure = Object.assign(new Error('rename denied'), { code: 'EACCES' })
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw failure })
  expect(() => {
    writeDesktopSettings(userData, {
      updates: { allowTestAuthPopupWindow: false }, welcome: { offline: true }, runtime: { pythonUtf8: true },
    })
  }).toThrow(failure)
  expect(readFileSync(path, 'utf8')).toBe(previous)
  expect(fs.readdirSync(join(userData, 'desktop'))).toEqual(['settings.json'])
})
