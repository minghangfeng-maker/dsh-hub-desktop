import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { extractPackageArchive } from '../src/tar-archive.ts'

/** Write one ustar header for a regular file. */
function header(name: string, size: number, options: { prefix?: string; type?: string } = {}): Buffer {
  const block = Buffer.alloc(512, 0)
  block.write(name, 0, 'utf8')
  block.write('0000644\0', 100, 'latin1')
  block.write('0000000\0', 108, 'latin1')
  block.write('0000000\0', 116, 'latin1')
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
  block.write(`${'0'.repeat(11)}\0`, 136, 'latin1')
  block.write('        ', 148, 'latin1')
  block.write(options.type ?? '0', 156, 'latin1')
  block.write('ustar\0', 257, 'latin1')
  block.write('00', 263, 'latin1')
  block.write(options.prefix ?? '', 345, 'latin1')
  let checksum = 0
  for (const byte of block) checksum += byte
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return block
}

/** Build one package archive from files, optionally with a wrapping directory. */
function archive(files: Record<string, string>, options: { raw?: boolean } = {}): Buffer {
  const blocks: Buffer[] = []
  for (const [name, contents] of Object.entries(files)) {
    const body = Buffer.from(contents)
    blocks.push(header(name, body.byteLength), body)
    const padding = (512 - (body.byteLength % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  const tar = Buffer.concat(blocks)
  return options.raw === true ? tar : gzipSync(tar)
}


/** Build a pax extended header record whose length field counts its own digits. */
function paxRecord(key: string, value: string): Buffer[] {
  const payload = ` ${key}=${value}\n`
  let length = payload.length + 2
  while (String(length).length + payload.length !== length) length = String(length).length + payload.length
  const record = Buffer.from(`${String(length)}${payload}`)
  const padding = Buffer.alloc((512 - (record.byteLength % 512)) % 512)
  return [header('PaxHeader', record.byteLength, { type: 'x' }), record, padding]
}

/** Build one regular file entry: header, body, and its block padding. */
function entry(name: string, contents: string, options: { prefix?: string } = {}): Buffer[] {
  const body = Buffer.from(contents)
  return [header(name, body.byteLength, options), body, Buffer.alloc((512 - (body.byteLength % 512)) % 512)]
}

describe('package archives', () => {
  it('reads the files of a gzipped archive without the package directory', () => {
    const extracted = extractPackageArchive(archive({
      'package/package.json': '{"name":"x"}', 'package/index.js': 'export {}\n',
    }))
    expect(extracted.map(file => file.path)).toEqual(['package.json', 'index.js'])
    expect(extracted[0]?.contents.toString()).toBe('{"name":"x"}')
  })

  it('reads an uncompressed tar archive as well', () => {
    expect(extractPackageArchive(archive({ 'package/a.txt': 'a' }, { raw: true }))).toHaveLength(1)
  })

  it('honours an ustar prefix for a long path', () => {
    const blocks: Buffer[] = []
    const body = Buffer.from('deep')
    blocks.push(header('file.txt', body.byteLength, { prefix: 'package/nested/directory' }), body, Buffer.alloc(1024))
    const extracted = extractPackageArchive(Buffer.concat(blocks))
    expect(extracted.map(file => file.path)).toEqual(['nested/directory/file.txt'])
  })

  it('applies a pax path record to the following entry', () => {
    const longPath = `package/${'segment/'.repeat(20)}file.txt`
    const extracted = extractPackageArchive(Buffer.concat([
      ...paxRecord('path', longPath),
      ...entry('ignored.txt', 'body'),
      Buffer.alloc(1024),
    ]))
    expect(extracted.map(file => file.path)).toEqual([`${'segment/'.repeat(20)}file.txt`])
  })

  it('applies a GNU long name record to the following entry', () => {
    const longName = `package/${'long/'.repeat(30)}file.txt`
    const name = Buffer.from(`${longName}\0`)
    const blocks = [header('LongLink', name.byteLength, { type: 'L' }), name, Buffer.alloc((512 - (name.byteLength % 512)) % 512)]
    const body = Buffer.from('body')
    blocks.push(header('ignored.txt', body.byteLength), body, Buffer.alloc(1024))
    expect(extractPackageArchive(Buffer.concat(blocks)).map(file => file.path)).toEqual([`${'long/'.repeat(30)}file.txt`])
  })

  it('rejects an entry that escapes the package directory', () => {
    expect(() => extractPackageArchive(archive({ 'package/../../etc/passwd': 'x' }))).toThrow(/escapes/u)
  })

  it('rejects an absolute entry', () => {
    expect(() => extractPackageArchive(archive({ '/etc/passwd': 'x' }))).toThrow(/absolute/u)
  })

  it('rejects a link entry', () => {
    const blocks = [header('package/link', 0, { type: '2' }), Buffer.alloc(1024)]
    expect(() => extractPackageArchive(Buffer.concat(blocks))).toThrow(/link/u)
  })

  it('rejects an archive with no files', () => {
    expect(() => extractPackageArchive(Buffer.alloc(1024))).toThrow(/no files/u)
  })

  it('reads the archive the packaging step ships', () => {
    const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'hub-connector-0.0.1.tgz'))
    const extracted = extractPackageArchive(fixture)
    expect(extracted.map(file => file.path).sort()).toEqual(['cordis.patch.yml', 'index.js', 'package.json'])
    const manifest: unknown = JSON.parse(extracted.find(file => file.path === 'package.json')?.contents.toString() ?? '{}')
    expect(manifest).toMatchObject({ name: '@dsh-hub/hub-connector', version: '0.0.1' })
  })
})
