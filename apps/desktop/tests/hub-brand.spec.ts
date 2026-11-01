import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { PLATFORM_MODULES } from '../../../packages/client/web/src/platform.ts'
import { BRAND_SOURCE, ICON_ARTBOARDS, standaloneArtboard } from '../hub/brand-artboard.mjs'
import { resolveClientHalf, svgDataUrl, wrapClientHalf } from '../hub/hub-plugin-client.mjs'

const APP_ROOT = join(import.meta.dirname, '..')
const PLUGIN = join(APP_ROOT, 'hub', 'plugins', 'hub-brand')
const CLIENT_PATH = join(PLUGIN, 'client', 'index.js')

/** One slot occupant the browser half registers, with the element it renders. */
interface BrandSlotRegistration {
  name: string
  component: (props: { size?: number }) => { tag: unknown; props: Record<string, unknown>; children: unknown[] }
}

/** The plugin's browser half, resolved exactly as `prepare:hub-runtime` resolves it. */
function buildBundle(): string {
  const mark = standaloneArtboard(readFileSync(BRAND_SOURCE, 'utf8'), ICON_ARTBOARDS.small)
  const body = resolveClientHalf(readFileSync(CLIENT_PATH, 'utf8'), {
    productName: 'DSH Hub', markUrl: svgDataUrl(mark),
  })
  return wrapClientHalf('@dsh-hub/hub-brand', body)
}

/** Evaluate one bundle the way the client module system does, with a stub module table. */
function loadBundle(bundle: string, scope: Record<string, unknown> = {}): { id: string; plugin: Record<string, unknown> } {
  let registration: { id: string; plugin: Record<string, unknown> } | undefined
  const host = {
    __ModuleLoader__: {
      load(entry: { id: string; factory: (require: (specifier: string) => unknown) => unknown }) {
        const react = {
          createElement: (tag: unknown, props: unknown, ...children: unknown[]) => ({ tag, props, children }),
        }
        registration = { id: entry.id, plugin: entry.factory((specifier: string) => {
          if (specifier === 'react') return react
          throw new Error(`unexpected module request ${specifier}`)
        }) as Record<string, unknown> }
      },
    },
  }
  runInNewContext(bundle, { window: host, ...scope })
  if (registration === undefined) throw new Error('bundle did not register a factory')
  return registration
}

describe('hub-brand package', () => {
  it('declares the client half and the bundle layer the Loader reads', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8')) as {
      exports: Record<string, string>
      dsh: { client: { platform: string }; bundle: { patch: string } }
      files: string[]
    }
    expect(manifest.exports['./client']).toBe('./lib/client.js')
    expect(manifest.dsh.client).toMatchObject({ platform: 'web' })
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('lib')
  })

  it('disables the upstream brand occupants and inserts itself', () => {
    const patch = readFileSync(join(PLUGIN, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- id: ui-brand-official\n  disabled: true')
    expect(patch).toContain('- id: hub-brand\n      name: \'@dsh-hub/hub-brand\'')
  })

  it('requires platform modules only', () => {
    const source = readFileSync(CLIENT_PATH, 'utf8')
    const requests = [...source.matchAll(/require\('([^']+)'\)/gu)].map(match => match[1])
    expect(requests.length).toBeGreaterThan(0)
    for (const specifier of requests) expect(PLATFORM_MODULES).toContain(specifier)
  })

  it('wraps itself in the module-table factory with both placeholders resolved', () => {
    const bundle = buildBundle()
    expect(bundle.startsWith('window.__ModuleLoader__.load({ id: "@dsh-hub/hub-brand", factory: (require) => {')).toBe(true)
    expect(bundle).toContain('return module.exports; } });')
    expect(bundle).not.toContain('@@')
    expect(bundle).toContain('data:image/svg+xml;base64,')
  })

  it('registers both sidebar brand slots and injects its stylesheet', () => {
    const style: { text: string; removed: boolean } = { text: '', removed: false }
    const document = {
      querySelector: () => null,
      createElement: () => ({
        dataset: {} as Record<string, string>,
        set textContent(value: string) { style.text = value },
        remove() { style.removed = true },
      }),
      head: { appendChild: () => undefined },
    }
    {
      const { id, plugin } = loadBundle(buildBundle(), { document })
      expect(id).toBe('@dsh-hub/hub-brand')
      expect(plugin.inject).toEqual(['slots'])
      const registered: BrandSlotRegistration[] = []
      const ctx = {
        effect: (callback: () => () => void) => { callback() },
        slots: {
          // The registry iterates a generator-shaped contribution; each yielded
          // value is the disposer of one registration.
          inject: (_name: string, callback: () => unknown) => {
            const contribution = callback()
            if (contribution !== null && typeof (contribution as { next?: unknown }).next === 'function') {
              for (const _disposer of contribution as Generator<() => void>) { /* registrations run on yield */ }
            }
            return contribution
          },
          register: (target: { name: string }, component: never) => {
            registered.push({ name: target.name, component })
            return () => undefined
          },
        },
      }
      ;(plugin.apply as (context: unknown) => void)(ctx)
      expect(registered.map(entry => entry.name)).toEqual(['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark'])
      expect(style.text).toContain('.dsh-hub-brand-name')
      const mark = registered[0]!.component({ size: 24 })
      expect(mark.tag).toBe('img')
      expect(String(mark.props.src).startsWith('data:image/svg+xml;base64,')).toBe(true)
      expect(mark.props.width).toBe(24)
      const name = registered[1]!.component({})
      expect(name.children).toEqual(['DSH Hub'])
      // The hero passes its own layout class; the mark keeps it alongside ours.
      const hero = registered[2]!.component({ size: 34, className: 'heroFish' } as { size?: number })
      expect(hero.props.className).toBe('dsh-hub-brand-mark heroFish')
      expect(hero.props.width).toBe(34)
    }
  })
})

describe('browser-half wrapper', () => {
  it('fails loudly on an unresolved placeholder', () => {
    expect(() => resolveClientHalf('const a = "@@OTHER@@"', { productName: 'DSH Hub', markUrl: 'data:,' }))
      .toThrow('@@OTHER@@')
  })

  it('escapes nothing and keeps the body verbatim apart from the placeholders', () => {
    const body = "const name = '@@PRODUCT_NAME@@'\nconst mark = '@@MARK_URL@@'"
    expect(resolveClientHalf(body, { productName: 'DSH Hub', markUrl: 'data:image/svg+xml;base64,AA==' }))
      .toBe("const name = 'DSH Hub'\nconst mark = 'data:image/svg+xml;base64,AA=='")
  })

  it('encodes the mark as a base64 data URL of the SVG source', () => {
    expect(svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"/>'))
      .toBe(`data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`)
  })
})
