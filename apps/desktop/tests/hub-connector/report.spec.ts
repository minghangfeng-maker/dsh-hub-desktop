/**
 * The device report: the allowlist is the privacy boundary, so the builder must
 * refuse a member the Hub does not accept instead of sending it.
 */

import { describe, expect, it } from 'vitest'
import {
  DESKTOP_PLUGIN_KEYS,
  DESKTOP_REPORT_KEYS,
  assertMembers,
  buildDeviceReport,
  sourceOfLevel,
} from '../../hub/plugins/hub-connector/src/report.ts'

describe('device report builder', () => {
  it('emits exactly the members the Hub accepts', () => {
    const body = buildDeviceReport({
      reportedAt: '2026-10-22T00:00:00.000Z',
      appVersion: '0.2.2',
      appChannel: 'latest',
      runtimeVersion: '0.2.2',
      appliedRevision: 7,
      appliedAt: '2026-10-22T00:01:00.000Z',
      applyState: 'applied',
      applyErrorCode: null,
      errorCount: 0,
      plugins: [{ name: '@local/dsh-memory', version: '0.1.2', source: 'hub-default', state: 'enabled' }],
    })
    expect(Object.keys(body).every(key => DESKTOP_REPORT_KEYS.includes(key))).toBe(true)
    expect(body).toMatchObject({ schemaVersion: 1, appliedRevision: 7, applyState: 'applied' })
    const plugins = body.plugins as Array<Record<string, unknown>>
    expect(Object.keys(plugins[0] ?? {}).every(key => DESKTOP_PLUGIN_KEYS.includes(key))).toBe(true)
  })

  it('carries the failure code only for a failed plugin entry', () => {
    const body = buildDeviceReport({
      reportedAt: '2026-10-22T00:00:00.000Z',
      appliedRevision: null,
      appliedAt: null,
      applyState: 'partial',
      applyErrorCode: 'plugin_install_failed',
      errorCount: 1,
      plugins: [
        { name: 'a', version: '1.0.0', source: 'hub-core', state: 'failed', errorCode: 'plugin_hash_mismatch' },
        { name: 'b', version: '1.0.0', source: 'hub-core', state: 'enabled', errorCode: 'plugin_hash_mismatch' },
      ],
    })
    const plugins = body.plugins as Array<Record<string, unknown>>
    expect(plugins[0]?.errorCode).toBe('plugin_hash_mismatch')
    expect(plugins[1]?.errorCode).toBeUndefined()
    // A failed entry always names a cause from the Hub's fixed enum.
    const failed = buildDeviceReport({
      reportedAt: '2026-10-22T00:00:00.000Z',
      appliedRevision: null,
      appliedAt: null,
      applyState: 'failed',
      applyErrorCode: null,
      errorCount: 1,
      plugins: [{ name: 'a', version: '1.0.0', source: 'hub-core', state: 'failed' }],
    })
    expect((failed.plugins as Array<Record<string, unknown>>)[0]?.errorCode).toBe('unknown')
  })

  it('refuses one extra member at either level', () => {
    expect(() => { assertMembers({ schemaVersion: 1, extra: true }, DESKTOP_REPORT_KEYS, []) }).toThrow(/not on the Hub allowlist/u)
    expect(() => {
      assertMembers({ name: 'a', version: '1.0.0', source: 'hub-core', state: 'enabled', path: '/tmp/x' }, DESKTOP_PLUGIN_KEYS, [])
    }).toThrow(/not on the Hub allowlist/u)
    expect(() => { assertMembers({ schemaVersion: 1 }, DESKTOP_REPORT_KEYS, ['reportedAt']) }).toThrow(/required/u)
  })

  it('maps manifest levels onto the report source', () => {
    expect(sourceOfLevel('core')).toBe('hub-core')
    expect(sourceOfLevel('default')).toBe('hub-default')
    expect(sourceOfLevel('optional')).toBe('hub-optional')
  })
})
