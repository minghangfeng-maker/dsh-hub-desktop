/**
 * The shared adapter package, loaded at runtime.
 *
 * `@dsh-hub/dsh-node-remote` is the one implementation of the mobile frame
 * translation, owned by the Hub worktree and shipped as a portable package. This
 * module only loads it and adapts its surface to the relay, so a checkout without
 * the package still starts (the switch reports why) and the package itself never
 * depends on this repository.
 */

import { createRequire } from 'node:module'
import type { RelayAdapter, RelayCapabilities, RelayChannel } from './relay.ts'
import type { HostCookie } from './host-cookie.ts'

/** Node's require, resolved from this package's own installation. */
const requireFromHere = createRequire(import.meta.url)

/** Package name of the shared adapter. */
export const NODE_REMOTE_PACKAGE = '@dsh-hub/dsh-node-remote'

/** The parts of the package this connector calls, validated at load time. */
export interface NodeRemoteModule {
  /**
   * Probe the Host read-only and build nothing.
   * @param options - Host origin and credentials.
   * @returns the Host's capability flags.
   */
  readonly probeNodeRemote?: (options: NodeRemoteOptionsShape) => Promise<NodeProbeShape>
  /**
   * Build one adapter, probing the Host first.
   * @param options - Host origin, credentials, and node identity.
   * @returns the adapter.
   */
  readonly createNodeRemote: (options: NodeRemoteOptionsShape) => Promise<NodeRemoteShape>
}

/** Options a read-only probe needs: the Host origin and its credential. */
export interface NodeRemoteProbeOptions {
  readonly origin: string
  readonly headers: () => Promise<Record<string, string>> | Record<string, string>
  readonly log?: (event: string, meta?: Record<string, unknown>) => void
}

/** Options shape the package accepts; `headers` is read per request. */
export interface NodeRemoteOptionsShape extends NodeRemoteProbeOptions {
  readonly node: { readonly id: string; readonly kind: 'desktop'; readonly name: string; readonly status: string }
}

/** What a read-only probe answers. */
export interface NodeProbeShape {
  readonly compatible: boolean
  readonly capabilities: RelayCapabilities
  readonly missing: readonly string[]
}

/** The adapter surface the package returns. */
export interface NodeRemoteShape {
  readonly capabilities: RelayCapabilities
  dispatch(frame: unknown, sink: (frame: unknown) => void): Promise<void>
  close(): Promise<void>
}

/**
 * Read the module namespace of a require result, accepting the `default` wrapper a
 * bundler may insert around an ESM package.
 * @param loaded - value `require` returned.
 * @returns the object holding the named exports, or undefined.
 */
function namespaceOf(loaded: unknown): Record<string, unknown> | undefined {
  if (typeof loaded !== 'object' || loaded === null) return undefined
  const record = loaded as Record<string, unknown>
  if (typeof Reflect.get(record, 'createNodeRemote') === 'function') return record
  const fallback = Reflect.get(record, 'default')
  if (typeof fallback === 'object' && fallback !== null && typeof Reflect.get(fallback, 'createNodeRemote') === 'function') {
    return fallback as Record<string, unknown>
  }
  return undefined
}

/** Whether a value exposes the eight capability booleans. */
function isCapabilities(value: unknown): value is RelayCapabilities {
  if (typeof value !== 'object' || value === null) return false
  const keys = ['sessions', 'history', 'send', 'stop', 'stream', 'questions', 'approvals', 'create'] as const
  if (!keys.every(key => typeof Reflect.get(value, key) === 'boolean')) return false
  // `approvals` may arrive false from a build that cannot answer; the Hub must not refuse the node for it.
  return true
}

/**
 * Load the shared adapter package.
 * @returns the validated exports, or undefined when the package is not installed.
 */
export function loadNodeRemote(): NodeRemoteModule | undefined {
  let loaded: unknown
  try {
    loaded = requireFromHere(NODE_REMOTE_PACKAGE)
  } catch {
    return undefined
  }
  const namespace = namespaceOf(loaded)
  if (namespace === undefined) return undefined
  const create = Reflect.get(namespace, 'createNodeRemote')
  if (typeof create !== 'function') return undefined
  const probe = Reflect.get(namespace, 'probeNodeRemote')
  return {
    createNodeRemote: create as NodeRemoteModule['createNodeRemote'],
    ...typeof probe === 'function' ? { probeNodeRemote: probe as NonNullable<NodeRemoteModule['probeNodeRemote']> } : {},
  }
}

/**
 * Probe the Host without building an adapter.
 * @param module - loaded package.
 * @param options - Host origin and credential reader.
 * @returns capability flags, or null when this package build cannot probe alone.
 */
export async function probeCapabilities(
  module: NodeRemoteModule,
  options: {
    readonly origin: string
    readonly cookie: HostCookie
    readonly node: { readonly id: string; readonly name: string; readonly status: string }
  },
): Promise<NodeProbeShape | null> {
  if (module.probeNodeRemote === undefined) return null
  const result: unknown = await module.probeNodeRemote({
    origin: options.origin,
    headers: async () => ({ cookie: await options.cookie.read() }),
    node: { id: options.node.id, kind: 'desktop', name: options.node.name, status: options.node.status },
  })
  if (typeof result !== 'object' || result === null) return null
  const capabilities = Reflect.get(result, 'capabilities')
  if (!isCapabilities(capabilities)) return null
  const missing = Reflect.get(result, 'missing')
  return {
    compatible: Reflect.get(result, 'compatible') === true,
    capabilities,
    missing: Array.isArray(missing) ? missing.filter((item): item is string => typeof item === 'string') : [],
  }
}

/**
 * Build one relay adapter over the shared package.
 * @param module - loaded package.
 * @param options - Host origin, credential reader, and the channel's node identity.
 * @returns the adapter the relay drives.
 */
export async function createSharedAdapter(
  module: NodeRemoteModule,
  options: {
    readonly origin: string
    readonly cookie: HostCookie
    readonly channel: RelayChannel
    readonly nodeName: string
    readonly hostStatus: () => string
    readonly log?: (event: string, meta?: Record<string, unknown>) => void
  },
): Promise<RelayAdapter> {
  // A phone channel outlives a rotated cookie, so the adapter reads it per request.
  const remote = await module.createNodeRemote({
    origin: options.origin,
    headers: async () => ({ cookie: await options.cookie.read() }),
    node: {
      id: options.channel.nodeId,
      kind: 'desktop',
      name: options.nodeName,
      status: options.hostStatus(),
    },
    ...options.log === undefined ? {} : { log: options.log },
  })
  if (typeof remote.dispatch !== 'function' || typeof remote.close !== 'function') {
    throw new Error('node-remote: the package returned an adapter without dispatch/close')
  }
  return {
    dispatch: async (frame, send) => { await remote.dispatch(frame, send) },
    close: async () => { await remote.close() },
  }
}
