/**
 * Real generated Typert descriptors for the adapter fixtures.
 *
 * The shared adapter probes endpoints by *endpoint name*, and the gateway validates
 * and dispatches by the descriptor this composition registered. A hand-written
 * descriptor can therefore make a probe pass while the real signature is wrong, so
 * these fixtures load the generator's own `TYPERT` output instead:
 *
 * - `DSH_TYPERT_PACKAGES` names the directory holding `packages/` with built `lib/`
 *   (a source checkout after `pnpm run build:artifacts`); without it the loader uses
 *   this repository's own tree and skips the fixture when the artifacts are absent.
 * - A missing package or endpoint fails loudly: a fixture that silently replaced a
 *   real descriptor would defeat the point of using generated ones.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

/** Generated descriptor module shape. */
interface GeneratedModule {
  readonly TYPERT?: { readonly invocations?: readonly InvocationDescriptor[] }
}

/** Packages holding the endpoints the mobile adapter probes. */
const SOURCE_PACKAGES = [
  'api/session-controller',
  'interaction/user-questions',
  'api/workspace-controller',
]

/**
 * Root holding `packages/` with built `lib/` directories.
 * @returns the configured root, else this repository's own tree.
 */
export function typertPackagesRoot(): string {
  const configured = (process.env.DSH_TYPERT_PACKAGES ?? '').trim()
  if (configured !== '') return configured
  // apps/desktop/tests/hub-connector/ → repository root
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..', 'packages')
}

/**
 * Load the generated descriptors for a set of endpoints.
 * @param endpoints - endpoint ids such as `session/list`.
 * @returns the matching descriptors, in generated order.
 * @throws {Error} when an artifact or an endpoint is missing; the fixture must not guess.
 */
export async function loadGeneratedDescriptors(endpoints: readonly string[]): Promise<InvocationDescriptor[]> {
  const root = typertPackagesRoot()
  const wanted = new Set(endpoints)
  const found = new Map<string, InvocationDescriptor>()
  const missingArtifacts: string[] = []
  for (const relative of SOURCE_PACKAGES) {
    const file = join(root, relative, 'lib', 'typert.host.js')
    if (!existsSync(file)) {
      missingArtifacts.push(file)
      continue
    }
    const module = await import(pathToFileURL(file).href) as GeneratedModule
    for (const descriptor of module.TYPERT?.invocations ?? []) {
      const id = `${descriptor.namespace}/${descriptor.method}`
      if (wanted.has(id)) found.set(id, descriptor)
    }
  }
  if (missingArtifacts.length > 0) {
    throw new Error(
      'fixture needs generated descriptors; build them with `pnpm run build:artifacts` '
      + `or point DSH_TYPERT_PACKAGES at a built tree. Missing: ${missingArtifacts.join(', ')}`,
    )
  }
  const missingEndpoints = [...wanted].filter(id => !found.has(id))
  if (missingEndpoints.length > 0) {
    throw new Error(`generated descriptors do not define: ${missingEndpoints.join(', ')}`)
  }
  return [...found.values()]
}
