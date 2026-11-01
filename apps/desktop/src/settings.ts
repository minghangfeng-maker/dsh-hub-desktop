/**
 * Local Electron shell settings, loaded once per process independently of the Host.
 * Ownership: .agents/notes/implemented/architecture/2026-10-08-desktop-shell-configuration.md.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Resolved shell preferences; absent fields use the defaults without rewriting existing files. */
export interface DesktopSettings {
  readonly updates: {
    readonly allowTestAuthPopupWindow: boolean
  }
  /**
   * Whether the user chose to use the workspace without a Hub account.
   *
   * The welcome window owns the choice; the shell only needs it before the Host
   * exists to decide between the entry page and the workspace at startup.
   */
  readonly welcome: {
    readonly offline: boolean
  }
  readonly runtime: {
    /**
     * Whether the bundled Python runs with `PYTHONUTF8=1`.
     *
     * The shell owns this value because it composes the Host environment before the
     * Host exists: a profile configuration would have to be read by the Host to learn
     * its own bootstrap input. `true` fixes the encoding defects of a Windows console
     * code page, and `false` restores the interpreter's system-encoding defaults for
     * scripts that depend on them.
     */
    readonly pythonUtf8: boolean
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read shell settings, creating the default document exclusively when missing.
 * @param userData - Electron's userData directory, independent of DSH_HOME.
 * @returns Validated settings, or defaults when reading, creating or validating fails; changes require a restart.
 */
export function readDesktopSettings(userData: string): DesktopSettings {
  const directory = join(userData, 'desktop')
  const path = join(directory, 'settings.json')
  const defaults: DesktopSettings = {
    updates: { allowTestAuthPopupWindow: false },
    welcome: { offline: false },
    runtime: { pythonUtf8: true },
  }
  try {
    let raw: string
    try { raw = readFileSync(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      try { writeFileSync(path, `${JSON.stringify(defaults, null, 2)}\n`, { flag: 'wx', mode: 0o600 }) } catch (error) {
        // An existing document belongs to the user, including one created during initialization.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      raw = readFileSync(path, 'utf8')
    }
    const value: unknown = JSON.parse(raw)
    if (!record(value) || (value.updates !== undefined && !record(value.updates))
      || (value.welcome !== undefined && !record(value.welcome))
      || (value.runtime !== undefined && !record(value.runtime))) {
      throw new Error('expected a JSON object with optional updates, welcome and runtime objects')
    }
    const allow = value.updates?.allowTestAuthPopupWindow
    if (allow !== undefined && typeof allow !== 'boolean') {
      throw new Error('updates.allowTestAuthPopupWindow must be true or false')
    }
    const offline = value.welcome?.offline
    if (offline !== undefined && typeof offline !== 'boolean') {
      throw new Error('welcome.offline must be true or false')
    }
    const pythonUtf8 = value.runtime?.pythonUtf8
    if (pythonUtf8 !== undefined && typeof pythonUtf8 !== 'boolean') {
      throw new Error('runtime.pythonUtf8 must be true or false')
    }
    return {
      updates: { allowTestAuthPopupWindow: allow ?? false },
      welcome: { offline: offline ?? false },
      runtime: { pythonUtf8: pythonUtf8 ?? true },
    }
  } catch (error) {
    try {
      console.warn(`desktop settings: ${path}: using defaults because settings could not be loaded`, error)
    } catch (_logError) {
      // Diagnostic output is best effort; its failure must not make optional settings fatal.
      // TODO: Persist settings diagnostics when console output is unavailable, without blocking startup.
    }
    return defaults
  }
}

/**
 * Persist shell settings that change while the application runs.
 *
 * Only the fields this module owns are replaced: an existing document keeps any
 * other keys it already carries, and the file is replaced atomically so a failure
 * never leaves a half-written document behind.
 * @param userData - Electron's userData directory, independent of DSH_HOME.
 * @param settings - next resolved settings; the owner passes its full snapshot.
 * @returns after the document replacement completes.
 */
export function writeDesktopSettings(userData: string, settings: DesktopSettings): void {
  const directory = join(userData, 'desktop')
  const path = join(directory, 'settings.json')
  let existing: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (record(value)) existing = value
  } catch (error) {
    // A missing file is the first write; an unreadable one is replaced by this snapshot.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  const document = {
    ...existing,
    updates: { ...(record(existing.updates) ? existing.updates : {}), allowTestAuthPopupWindow: settings.updates.allowTestAuthPopupWindow },
    welcome: { ...(record(existing.welcome) ? existing.welcome : {}), offline: settings.welcome.offline },
    runtime: { ...(record(existing.runtime) ? existing.runtime : {}), pythonUtf8: settings.runtime.pythonUtf8 },
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
