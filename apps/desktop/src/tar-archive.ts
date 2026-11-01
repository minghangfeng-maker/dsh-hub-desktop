/**
 * Minimal reader for the npm package archives (`*.tgz`) the Hub ships.
 *
 * The desktop shell installs a bundled Hub plugin without running npm or pnpm:
 * a package archive is a gzipped tar whose single top-level directory holds the
 * package files, so the shell only needs the ability to read one. This reader
 * accepts the POSIX ustar header and the two extensions packaging tools emit for
 * long paths (pax `x` records and GNU `L` names); it rejects anything that could
 * escape the destination.
 */

import { gunzipSync } from 'node:zlib'

/** One regular file of an extracted package. */
export interface ArchiveFile {
  /** Path relative to the package directory, using `/` separators. */
  readonly path: string
  /** File contents. */
  readonly contents: Buffer
}

const TAR_BLOCK = 512

/** Fields of one archive header that this reader uses. */
interface TarHeader {
  readonly name: string
  readonly prefix: string
  readonly size: number
  readonly type: string
}

function ascii(bytes: Buffer, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length)
  const end = slice.indexOf(0)
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8')
}

/** Read a tar size field: NUL- or space-terminated octal, or GNU base-256 for large values. */
function sizeField(bytes: Buffer, start: number): number {
  const first = bytes[start] ?? 0
  if ((first & 0x80) !== 0) {
    let value = 0
    for (let index = start + 1; index < start + 12; index += 1) value = value * 256 + (bytes[index] ?? 0)
    return value
  }
  const text = ascii(bytes, start, 12).trim()
  return text === '' ? 0 : Number.parseInt(text, 8)
}

function readHeader(bytes: Buffer, offset: number): TarHeader {
  return {
    name: ascii(bytes, offset, 100),
    prefix: ascii(bytes, offset + 345, 155),
    size: sizeField(bytes, offset + 124),
    type: String.fromCharCode(bytes[offset + 156] ?? 0),
  }
}

/** Parse the pax extended-header records (`<length> <key>=<value>\n`). */
function parsePaxRecords(bytes: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let offset = 0
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(bytes.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.length) break
    const record = bytes.subarray(space + 1, offset + length - 1).toString('utf8')
    const separator = record.indexOf('=')
    if (separator > 0) records.set(record.slice(0, separator), record.slice(separator + 1))
    offset += length
  }
  return records
}

/**
 * Reject archive paths that would escape the destination directory.
 * @param path - Raw header path.
 * @returns Normalized relative path with `/` separators.
 * @throws {Error} When the path is absolute or contains a parent segment.
 */
function normalizeArchivePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '')
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error(`desktop hub plugin: archive entry ${JSON.stringify(path)} is an absolute path`)
  }
  if (normalized.split('/').includes('..')) {
    throw new Error(`desktop hub plugin: archive entry ${JSON.stringify(path)} escapes the package directory`)
  }
  return normalized
}

/**
 * Strip the single top-level directory of an npm package archive.
 * @param path - Normalized archive path.
 * @returns Package-relative path, or the original path when no wrapper directory exists.
 */
function stripPackageRoot(path: string): string {
  const separator = path.indexOf('/')
  if (separator === -1) return path
  return path.slice(separator + 1)
}

/**
 * Read every regular file of a gzipped npm package archive.
 * @param archive - Raw `.tgz` bytes.
 * @returns Files in archive order, without the `package/` wrapper.
 * @throws {Error} On a malformed archive, a symlink or hard link entry, or a parent-escaping path.
 */
export function extractPackageArchive(archive: Uint8Array): ArchiveFile[] {
  const buffer = Buffer.from(archive)
  const tar = (buffer[0] === 0x1f && buffer[1] === 0x8b) ? gunzipSync(buffer) : buffer
  const files: ArchiveFile[] = []
  let offset = 0
  let pendingPath: string | undefined
  while (offset + TAR_BLOCK <= tar.length) {
    const header = readHeader(tar, offset)
    if (header.name === '') break
    const body = tar.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK + header.size)
    offset += TAR_BLOCK + Math.ceil(header.size / TAR_BLOCK) * TAR_BLOCK
    switch (header.type) {
      case 'x': {
        const path = parsePaxRecords(body).get('path')
        if (path !== undefined) pendingPath = path
        continue
      }
      case 'L': {
        const end = body.indexOf(0)
        pendingPath = (end === -1 ? body : body.subarray(0, end)).toString('utf8')
        continue
      }
      case 'g':
        continue
      case '0':
      case '\0':
      case '': {
        const raw = pendingPath ?? (header.prefix === '' ? header.name : `${header.prefix}/${header.name}`)
        if (raw.endsWith('/')) {
          pendingPath = undefined
          continue
        }
        const path = stripPackageRoot(normalizeArchivePath(raw))
        if (path !== '') files.push({ path, contents: Buffer.from(body) })
        pendingPath = undefined
        continue
      }
      case '5':
        pendingPath = undefined
        continue
      case '1':
      case '2':
        throw new Error(`desktop hub plugin: archive entry ${JSON.stringify(pendingPath ?? header.name)} is a link, which a bundled plugin cannot contain`)
      default:
        // Extended attributes and vendor-specific records carry no package file.
        pendingPath = undefined
    }
  }
  if (files.length === 0) throw new Error('desktop hub plugin: archive contains no files')
  return files
}
