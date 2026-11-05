import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../../packages/credentials/credentials/tests/memory.ts'
import { HubAccount, type HubGrant } from '../../hub/plugins/hub-connector/src/account.ts'
import { HubConnector, type ConnectorHost } from '../../hub/plugins/hub-connector/src/connector.ts'
import { initialState, loadState, saveState } from '../../hub/plugins/hub-connector/src/state.ts'

it('finishes a pending removal after a restart even when the manifest and its ETag are unchanged', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'hub-removal-restart-'))
  const packageName = '@local/removal-test'
  const packageDirectory = join(profile, 'node_modules', '@local', 'removal-test')
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { [packageName]: 'file:./old.tgz' } }))
  const conditionalHeaders: (string | undefined)[] = []
  let revision = 3
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/desktop/manifest') {
      conditionalHeaders.push(request.headers['if-none-match'])
      if (request.headers['if-none-match'] === '"revision-3"') {
        response.writeHead(304).end()
        return
      }
      response.setHeader('etag', `"revision-${String(revision)}"`)
      response.end(JSON.stringify({
        schemaVersion: 1, revision, issuedAt: '2026-10-22T00:00:00.000Z', plugins: [], uninstall: [packageName],
        config: { fragments: [{ id: 'agent-default-model', mode: 'enforce', config: { provider: 'hub', model: 'test-model' } }] },
      }))
      return
    }
    if (request.url === '/api/desktop/devices/report') {
      request.resume()
      response.end(JSON.stringify({ desiredRevision: revision, reportIntervalSec: 900 }))
      return
    }
    response.writeHead(404).end('{}')
  })
  await new Promise<void>((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing server address')
  const origin = `http://127.0.0.1:${String(address.port)}`
  const fallback = initialState({ osLabel: 'Windows 11', installId: 'install-1' })
  saveState(profile, {
    ...fallback,
    deviceId: 'dv_0123456789abcdef0123456789abcdef',
    appliedRevision: 2,
    manifestEtag: '"revision-2"',
    managed: [{ name: packageName, version: '1.0.0', source: 'hub-default', enabled: true }],
  })
  const context = new Context()
  const credentials = new MemoryCredentials(context)
  let inUse = true
  const remove = vi.fn(async () => inUse ? { changed: false, error: 'bundle-in-use' } : { changed: true })
  const build = {
    appVersion: '0.2.1-rc.2', appChannel: 'latest', runtimeVersion: '0.2.1-rc.2',
    builtHubOrigin: origin, osLabel: 'Windows 11', installId: 'install-1',
    schemaDirectory: resolve(import.meta.dirname, '../../hub/plugins/hub-connector'),
  } as const
  const host: ConnectorHost = {
    profile, build, environment: {},
    account: {
      build, environment: {}, credentials, registerRoute: () => () => undefined,
      hubOrigin: () => origin, readState: () => loadState(profile, fallback), writeState: (state) => { saveState(profile, state) },
      emit: () => undefined, changed: () => undefined, now: () => new Date('2026-10-22T01:00:00Z'), random: size => Buffer.alloc(size),
    },
    pluginManager: {
      listBundles: async () => [{ name: packageName, version: '1.0.0', enabled: false, removable: true }],
      installBundle: async () => ({ changed: false }), removeBundle: remove, setBundleEnabled: async () => ({ changed: false }),
    },
  }
  const grant: HubGrant = {
    version: 1, token: 'test-device-token', hubOrigin: origin, deviceId: 'dv_0123456789abcdef0123456789abcdef',
    expiresAt: '2026-11-01T00:00:00Z', absoluteExpiresAt: '2026-12-01T00:00:00Z',
    user: { username: 'test', displayName: 'Test', role: 'user', roleLabel: '' }, wallet: null,
  }
  const create = (): HubConnector => new HubConnector(host, (accountHost) => {
    const account = new HubAccount(accountHost)
    vi.spyOn(account, 'readGrant').mockResolvedValue(grant)
    return account
  })
  const first = create()
  let restarted: HubConnector | undefined
  try {
    await first.pullManifest()
    await vi.waitFor(() => { expect(first.current.lastReport).toMatchObject({ appliedRevision: 3 }) })
    const waiting = loadState(profile, fallback)
    expect(waiting).toMatchObject({ appliedRevision: 3, applySequence: 1, pendingRemovals: [packageName] })
    expect(existsSync(packageDirectory)).toBe(true)
    first.stop()
    inUse = false
    restarted = create()
    await restarted.pullManifest()
    await vi.waitFor(() => { expect(restarted?.current.lastReport).toMatchObject({ appliedRevision: 3, plugins: [] }) })
    expect(remove).toHaveBeenCalledTimes(2)
    expect(conditionalHeaders).toEqual([undefined, undefined])
    expect(loadState(profile, fallback)).toMatchObject({
      appliedRevision: 3, applySequence: 2, pendingRemovals: [], managed: [], restart: null,
    })
    expect(existsSync(packageDirectory)).toBe(false)
    const dependencies = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(dependencies.dependencies[packageName]).toBeUndefined()
    await restarted.pullManifest()
    expect(conditionalHeaders.at(-1)).toBe('"revision-3"')
    expect(remove).toHaveBeenCalledTimes(2)
    restarted.stop()
    restarted = create()
    await restarted.pullManifest()
    await vi.waitFor(() => { expect(restarted?.current.applySequence).toBe(3) })
    expect(conditionalHeaders.at(-1)).toBeUndefined()
    // The delivered default lives in the connector's managed set, not the overlay.
    expect(loadState(profile, fallback).managedModels?.defaultSelection?.model).toBe('test-model')
    expect(readFileSync(join(profile, 'cordis.hub.patch.yml'), 'utf8')).not.toContain('agent-default-model')
    restarted.clearAfterSignOut()
    expect(readFileSync(join(profile, 'cordis.hub.patch.yml'), 'utf8')).not.toContain('test-model')
    // A stale response cannot roll back the already-applied revision.
    revision = 2
    saveState(profile, { ...restarted.current, manifestEtag: null })
    restarted.stop()
    restarted = create()
    await restarted.pullManifest()
    expect(remove).toHaveBeenCalledTimes(2)
    expect(restarted.current.appliedRevision).toBe(3)
  } finally {
    first.stop()
    restarted?.stop()
    server.closeAllConnections()
    await new Promise<void>((resolveClose, reject) => { server.close((error) => { if (error) reject(error); else resolveClose() }) })
    rmSync(profile, { recursive: true, force: true })
  }
})
