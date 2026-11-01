import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readHubOverlaySettings, HUB_OVERLAY_FILENAME } from '../src/hub-overlay.ts'

const roots: string[] = []
function profile(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hub-overlay-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Hub overlay settings', () => {
  it('reports nothing when the profile has no overlay', () => {
    expect(readHubOverlaySettings(profile())).toEqual({ diagnostics: [] })
  })

  it('reads the reserved proxy block from the overlay comments', () => {
    const directory = profile()
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, HUB_OVERLAY_FILENAME), [
      '# DSH Hub overlay.',
      '- id: hub-connector',
      '  config:',
      '    configSource: overlay',
      '# hubProxy.http=http://corp.example:8080',
      '# hubProxy.https=http://corp.example:8080/',
      '# hubProxy.noProxy=localhost,.corp.example',
      '',
    ].join('\n'))
    expect(readHubOverlaySettings(directory).proxy).toEqual({
      http: 'http://corp.example:8080',
      https: 'http://corp.example:8080',
      noProxy: 'localhost,.corp.example',
    })
  })

  it('ignores an unusable proxy URL and reports it', () => {
    const directory = profile()
    writeFileSync(join(directory, HUB_OVERLAY_FILENAME), '# hubProxy.http=socks5://127.0.0.1:1080\n')
    const settings = readHubOverlaySettings(directory)
    expect(settings.proxy).toBeUndefined()
    expect(settings.diagnostics.join(' ')).toContain('socks5://127.0.0.1:1080')
  })
})
