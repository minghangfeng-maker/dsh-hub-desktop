/**
 * The overlay file, the durable state, and the agent-mode service.
 *
 * These three are what the rest of the desktop reads from the connector: the
 * overlay is the only file the Loader applies last, the state file is the only
 * place the device identity survives a restart, and `hubAgentModes` is what the
 * two pilots consume on every model call.
 */

import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HUB_OVERLAY_FILENAME,
  declaredRowIds,
  emptyOverlay,
  renderOverlay,
  writeOverlay,
} from '../../hub/plugins/hub-connector/src/overlay.ts'
import {
  defaultDeviceName,
  initialState,
  loadState,
  saveState,
  statePath,
} from '../../hub/plugins/hub-connector/src/state.ts'
import { HubAgentModes, baseUrlFor } from '../../hub/plugins/hub-connector/src/agent-modes.ts'
import type { AccountHost } from '../../hub/plugins/hub-connector/src/account.ts'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'

/** A temporary profile directory. */
function profile(): string {
  return mkdtempSync(join(tmpdir(), 'hub-overlay-'))
}

describe('overlay rendering', () => {
  it('leaves the file and backup inventory untouched when the configuration is unchanged', () => {
    const directory = profile()
    const document = { revision: 3, connectorRow: true, fragments: [] }
    const path = writeOverlay(directory, renderOverlay(document, { userDeclared: new Set() }).text)
    const before = statSync(path)
    writeOverlay(directory, renderOverlay(document, { userDeclared: new Set() }).text)
    expect(statSync(path).ino).toBe(before.ino)
    expect(readdirSync(directory)).toEqual([HUB_OVERLAY_FILENAME])
  })
  it('writes the connector row, the fragments, and the reserved proxy block', () => {
    const rendered = renderOverlay({
      revision: 12,
      connectorRow: true,
      fragments: [
        { id: 'llm-pi-ai', mode: 'enforce', config: { providers: { hub: { baseURL: 'http://127.0.0.1:7971/v1' } } } },
        { id: 'agent-default-model', mode: 'default', config: { provider: 'hub', model: 'm1' } },
      ],
      proxy: { http: 'http://corp.example:8080', noProxy: 'localhost' },
      notice: '本周升级',
    }, { userDeclared: new Set(['agent-default-model']) })
    expect(rendered.text.endsWith('\n')).toBe(true)
    expect(rendered.text).toContain('# revision: 12')
    expect(rendered.text).toContain('- id: hub-connector')
    expect(rendered.text).toContain('- id: llm-pi-ai')
    // The header names what was skipped; the rows must not carry it.
    expect(rendered.rows.every(row => row.id !== 'agent-default-model')).toBe(true)
    expect(rendered.text).toContain('skipped by user patch: agent-default-model')
    expect(rendered.skipped).toEqual(['agent-default-model'])
    expect(rendered.text).toContain('# hubProxy.http=http://corp.example:8080')
    expect(rendered.text).toContain('# hubProxy.noProxy=localhost')
  })

  it('serializes a config object as JSON flow YAML the Loader can parse', () => {
    const rendered = renderOverlay({
      revision: 1,
      connectorRow: false,
      fragments: [{ id: 'x', mode: 'enforce', config: { nested: { list: [1, 2], text: 'a: b' } } }],
    }, { userDeclared: new Set() })
    const line = rendered.text.split('\n').find(entry => entry.includes('config:')) ?? ''
    const value = line.slice(line.indexOf('config:') + 'config:'.length).trim()
    expect(JSON.parse(value)).toEqual({ nested: { list: [1, 2], text: 'a: b' } })
  })

  it('renders a disabled flag as a boolean row, so the account switch can put rows back', () => {
    const rendered = renderOverlay({
      revision: 2,
      connectorRow: false,
      fragments: [],
      extraRows: [{ id: 'web-deepseek-api', disabled: false }, { id: 'web-search-deepseek', disabled: true }],
    }, { userDeclared: new Set() })
    expect(rendered.text).toContain('- id: web-deepseek-api\n  disabled: false')
    expect(rendered.text).toContain('- id: web-search-deepseek\n  disabled: true')
    // A row with neither a flag nor a config must not print "config: undefined".
    expect(rendered.text).not.toContain('config: undefined')
  })

  it('keeps one row per id, so an extra row or a delivered fragment outranks a generated one', () => {
    const rendered = renderOverlay({
      revision: 2,
      connectorRow: false,
      fragments: [
        { id: 'web', mode: 'enforce', config: { searchProvider: 'a' } },
        { id: 'web', mode: 'enforce', config: { searchProvider: 'b' } },
      ],
      extraRows: [{ id: 'llm-pi-ai', config: { providers: {} } }],
    }, { userDeclared: new Set() })
    const ids = rendered.rows.map(row => row.id)
    expect(ids.filter(id => id === 'web')).toHaveLength(1)
    // The first source wins: an earlier fragment is never rewritten by a later one.
    expect(rendered.rows.find(row => row.id === 'web')?.config).toEqual({ searchProvider: 'a' })
  })

  it('renders an empty document as a valid empty patch list, not an empty file', () => {
    const text = emptyOverlay(false)
    expect(text.startsWith('#')).toBe(true)
    expect(text).not.toMatch(/^- (?!id:)/mu)
  })

  it('reads the ids a user patch declares, inserted rows included', () => {
    const ids = declaredRowIds([
      '# comment',
      '- insert:',
      '    - id: plugin-a',
      '      name: pkg-a',
      '- id: plugin-b',
      '  config: {x: 1}',
    ].join('\n'))
    expect([...ids].sort()).toEqual(['plugin-a', 'plugin-b'])
  })

  it('writes atomically and keeps only the newest backups', () => {
    const directory = profile()
    for (let index = 0; index < 5; index += 1) {
      writeOverlay(directory, `# render ${String(index)}\n`)
      // Backups are timestamped; keep distinct stamps so the trim sees different ages.
      const files = readdirSync(directory).filter(name => name.startsWith(`${HUB_OVERLAY_FILENAME}.bak-`))
      expect(files.length).toBeLessThanOrEqual(3)
    }
    expect(readFileSync(join(directory, HUB_OVERLAY_FILENAME), 'utf8')).toBe('# render 4\n')
  })
})

describe('connector state', () => {
  it('round-trips through disk and repairs a foreign version', () => {
    const directory = profile()
    const state = initialState({ osLabel: 'Windows 11', hubOrigin: 'https://hub.example', installId: '0f0e0d0c-0b0a-4908-8706-050403020100' })
    expect(state.settings.deviceName).toBe(defaultDeviceName('Windows 11'))
    saveState(directory, { ...state, deviceId: 'dv_0123456789abcdef0123456789abcdef', appliedRevision: 3 })
    const loaded = loadState(directory, state)
    expect(loaded.deviceId).toBe('dv_0123456789abcdef0123456789abcdef')
    expect(loaded.appliedRevision).toBe(3)
    writeFileSync(statePath(directory), JSON.stringify({ schemaVersion: 99 }))
    expect(loadState(directory, state).deviceId).toBeNull()
  })
})

describe('hubAgentModes', () => {
  /** In-memory credential store. */
  class Store {
    readonly records = new Map<string, CredentialRecord>()
    readonly refs = new Map<string, string>()
    async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> { return this.records.get(key) }
    async modifyRecord(
      key: CredentialKey,
      mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
    ): Promise<CredentialRecord | undefined> {
      const next = await mutate(this.records.get(key))
      if (next !== undefined) this.records.set(key, next)
      return next
    }

    async deleteRecord(key: CredentialKey): Promise<void> { this.records.delete(key) }
    async set(ref: string, value: string): Promise<void> { this.refs.set(ref, value) }
    async unset(ref: string): Promise<void> { this.refs.delete(ref) }
    async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
      const value = this.refs.get(ref)
      return value === undefined ? undefined : { value, source: 'managed' }
    }
  }

  it('uses the two base-URL shapes the pilots append to', () => {
    expect(baseUrlFor('http://127.0.0.1:7971/v1', 'claude-code')).toBe('http://127.0.0.1:7971')
    expect(baseUrlFor('http://127.0.0.1:7971/v1', 'codex')).toBe('http://127.0.0.1:7971/v1')
    expect(baseUrlFor('http://127.0.0.1:7971', 'codex')).toBe('http://127.0.0.1:7971/v1')
  })

  it('hydrates from the store, clears on sign-out, and reports availability synchronously', async () => {
    const store = new Store()
    const host: AccountHost = {
      build: {
        appVersion: '0.2.2',
        appChannel: 'latest',
        runtimeVersion: '0.2.2',
        builtHubOrigin: '',
        osLabel: 'Windows 11',
        installId: '0f0e0d0c-0b0a-4908-8706-050403020100',
        schemaDirectory: '.',
      },
      environment: {},
      credentials: store as unknown as CredentialProvider,
      registerRoute: () => () => undefined,
      hubOrigin: () => 'https://hub.example',
      readState: () => initialState({ osLabel: 'Windows 11', hubOrigin: '', installId: 'x' }),
      writeState: () => undefined,
      emit: () => undefined,
      changed: () => undefined,
      now: () => new Date(),
      random: () => Buffer.alloc(16),
    }
    await store.set('HUB_CLAUDE_KEY', 'sk-dsh-claude')
    await store.modifyRecord('hub-connector/mode-claude-code' as CredentialKey, () => Promise.resolve({
      kind: 'grant',
      payload: { version: 1, baseUrl: 'https://hub.example/v1', keyId: 4, label: 'DSH Hub' },
    }))
    const service = new HubAgentModes({ hubOrigin: () => host.hubOrigin(), deviceToken: async () => 'dsh_dev_x', credentials: store as unknown as CredentialProvider })
    expect(service.available('claude-code')).toBe(false)
    await service.hydrate()
    expect(service.available('claude-code')).toBe(true)
    expect(service.credentials('claude-code')).toMatchObject({ key: 'sk-dsh-claude', baseUrl: 'https://hub.example', auth: 'apiKey' })
    expect(service.credentials('codex')).toBeNull()
    let notified = 0
    const off = service.onChange('claude-code', () => { notified += 1 })
    service.clear()
    expect(service.available('claude-code')).toBe(false)
    expect(notified).toBe(1)
    off()
    service.clear()
    expect(notified).toBe(1)
  })

  it('refuses to answer while signed out', async () => {
    const store = new Store()
    const service = new HubAgentModes({ hubOrigin: () => '', deviceToken: async () => '', credentials: store as unknown as CredentialProvider })
    const result = await service.refresh('codex')
    expect(result).toEqual({ ok: false, error: '请先登录 DSH Hub' })
    expect(service.available('codex')).toBe(false)
  })
})
