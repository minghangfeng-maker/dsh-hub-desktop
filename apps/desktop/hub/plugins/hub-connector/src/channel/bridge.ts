/**
 * Binds the relay to the outbound channel: one relay per live connection, gone the
 * moment the connection is.
 *
 * The gate the mobile contract needs lives here. The Hub opens a phone channel only
 * when a phone is actually connected, so an adapter — and therefore the Host's
 * `$events` stream — exists only while that phone channel does. A desktop with the
 * switch on and no phone keeps `hasLiveClient()` false.
 *
 * Capabilities come from a read-only probe that runs as soon as the switch comes on,
 * before any adapter exists: without them the Hub never opens a channel, and probing
 * through the full adapter would open `$events` while no phone is present.
 */

import type { ChannelController } from './controller.ts'
import { DesktopRelay, type RelayAdapter, type RelayCapabilities, type RelayChannel } from './relay.ts'

/** How long one probe may take before the relay reports "not probed yet". */
const PROBE_TIMEOUT_MS = 5_000

/** Retry cadence while the probe has not produced a capability set. */
const PROBE_RETRY_MS = 30_000

/** What a read-only probe reports before any adapter exists. */
export interface ChannelProbeResult {
  /** False when the Host is missing endpoints the phone needs. */
  readonly compatible: boolean
  /** Capability flags to publish in `hello`. */
  readonly capabilities: RelayCapabilities
  /** Endpoints the probe found missing, for the local log. */
  readonly missing: readonly string[]
}

/** Collaborators the bridge reaches outside itself. */
export interface ChannelRelayOptions {
  /** Hub-issued device identity, read at hello time; undefined signs the relay out. */
  readonly deviceId: () => string | undefined
  /** Application version reported in hello. */
  readonly clientVersion: string
  /** Adapter capabilities from a read-only probe, or null when this build cannot probe alone. */
  readonly probe?: () => Promise<ChannelProbeResult | null>
  /** Builds the adapter for one phone channel; the shared package's factory by default. */
  readonly adapter: (channel: RelayChannel) => Promise<RelayAdapter>
  /** Local Host status reported in hello. */
  readonly hostStatus?: () => 'running' | 'stopped' | 'starting'
  /** Diagnostic sink; never receives frame payloads. */
  readonly log?: (message: string) => void
}

/**
 * Follow the channel's connection with one relay.
 * @param channel - outbound channel the relay speaks through.
 * @param options - identity, probe, and the adapter factory.
 * @returns disposer that stops following and closes the relay.
 */
export function attachChannelRelay(channel: ChannelController, options: ChannelRelayOptions): () => void {
  let relay: DesktopRelay | undefined
  let detachFrames: (() => void) | undefined
  let capabilities: RelayCapabilities | null = null
  let probing = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const log = options.log ?? (() => undefined)

  const stop = (): void => {
    detachFrames?.()
    detachFrames = undefined
    const current = relay
    relay = undefined
    if (current !== undefined) void current.disconnected()
  }

  const runProbe = async (): Promise<void> => {
    if (stopped || probing || options.probe === undefined || channel.status().phase !== 'online') return
    probing = true
    try {
      const result = await Promise.race<ChannelProbeResult | null>([
        options.probe(),
        new Promise<null>((resolve) => {
          const timer = setTimeout(() => { resolve(null) }, PROBE_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
      if (stopped) return
      if (result !== null) {
        if (!result.compatible) {
          log(`relay: the Host is missing mobile endpoints (${result.missing.join(', ')}); capabilities stay unknown`)
        } else {
          capabilities = result.capabilities
          // A relay already on the wire publishes the new readiness to the Hub; one that
          // has not started yet sends its first hello with these capabilities.
          relay?.hello()
          return
        }
      }
      log('relay: the adapter cannot probe the Host yet; capabilities stay unknown')
    } catch (error) {
      log(`relay: probe failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      probing = false
      if (!stopped && capabilities === null && channel.status().phase === 'online') {
        retry = setTimeout(() => { void runProbe() }, PROBE_RETRY_MS)
        retry.unref?.()
      }
    }
  }

  const start = (): void => {
    if (relay !== undefined) return
    const deviceId = options.deviceId()
    if (deviceId === undefined) {
      log('relay: no device identity, staying off the wire')
      return
    }
    const created = new DesktopRelay({
      deviceId,
      clientVersion: options.clientVersion,
      hostStatus: options.hostStatus ?? (() => 'running'),
      capabilities: () => capabilities,
      adapter: options.adapter,
      send: (text) => { channel.send(text) },
      log,
    })
    relay = created
    detachFrames = channel.attachFrames((text) => { created.receive(text) })
    created.hello()
    void runProbe()
  }

  const apply = (phase: string): void => {
    if (phase === 'online') start()
    else {
      if (retry !== undefined) clearTimeout(retry)
      retry = undefined
      stop()
    }
  }

  apply(channel.status().phase)
  const unsubscribe = channel.onChange((status) => { apply(status.phase) })
  return () => {
    stopped = true
    if (retry !== undefined) clearTimeout(retry)
    retry = undefined
    unsubscribe()
    stop()
  }
}
