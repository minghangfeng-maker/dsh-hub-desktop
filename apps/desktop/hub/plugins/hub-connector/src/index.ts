/**
 * The Hub connector plugin: the desktop's account provider, device identity,
 * manifest applier, and agent-mode service.
 *
 * The installer ships this package as a core profile plugin (it is never
 * delivered by the Hub), so `apply` runs once per Host start inside
 * the desktop profile. Everything it registers is a documented seam:
 *
 * - `deepseekAccount` — the account service, replacing the upstream platform
 *   provider in the composition (D2 option A), so the welcome gate, the sidebar
 *   menu, and the expiry notice keep working with a Hub grant.
 * - `hubAgentModes` — the Cordis service the Claude Code and Codex pilots prefer
 *   over `HUB_*` environment variables (rulings #11, #12).
 * - One loopback callback route for the browser login, plus the read/write
 *   routes the account page uses.
 *
 * Configuration comes from the bundle layer; the durable, user-editable part
 * lives in `<profile>/desktop-hub/state.json`. No credential ever reaches
 * `process.env`, a log line, or this file.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-pi-ai'
import { HubAccount } from './account.ts'
import type { AccountHost } from './account.ts'
import { attachChannelRelay } from './channel/bridge.ts'
import { ChannelController } from './channel/controller.ts'
import { createHostCookie } from './channel/host-cookie.ts'
import { createSharedAdapter, loadNodeRemote, probeCapabilities } from './channel/node-remote.ts'
import { ChannelLifecycle } from './channel/lifecycle.ts'
import { createWebSocketTransport } from './channel/transport.ts'
import { HubConnector } from './connector.ts'
import type { ConnectorHost, PluginManagerAccess } from './connector.ts'
import { osLabel, osMajor, readAppVersion, readBuildHubOrigin, type AppChannel } from './device.ts'
import { info, warn } from './log.ts'
import { finishUpstreamOnboarding } from './onboarding.ts'
import { registerClientRoutes } from './routes.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A DSH Hub device grant has been stored.
     * @mode emit
     */
    'hub-connector/signed-in'(): void
    /**
     * The stored DSH Hub grant has been removed, locally or by the Hub.
     * @mode emit
     */
    'hub-connector/signed-out'(): void
  }
}

/** Plugin configuration, supplied by the bundle layer. */
export interface Config {
  /** Name of the patch layer that supplied this configuration, for diagnostics only. */
  readonly configSource?: string
  /**
   * Whether this connector provides the account service. False hands it back to
   * the upstream DeepSeek provider, which the Hub overlay row enables together
   * with the model route it belongs to; the choice needs a restart because both
   * are composition rows.
   */
  readonly provideAccount?: boolean
}

/** Stable Cordis plugin name. */
export const name = 'hub-connector'

/**
 * Services that must exist before the connector can advertise an account.
 * `webServer` receives the browser callback and the account page's routes, and
 * `connection` authenticates those routes; without the dependency Cordis would
 * activate this row before either is available and the routes would silently
 * never exist.
 */
export const inject = ['credentials', 'webServer', 'connection']

/**
 * Package root: `lib/` in a packaged profile, `src/` in a source checkout. The
 * schema and the build identity live beside `package.json`, one level above it.
 */
const MODULE_DIRECTORY = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Read the release channel the installer recorded beside this package.
 * @param directory - Directory holding an optional `build-info.json`.
 * @returns `nightly` or `latest`; `latest` when the build baked no channel.
 */
function readChannel(directory: string): AppChannel {
  try {
    const value: unknown = JSON.parse(readFileSync(join(directory, 'build-info.json'), 'utf8'))
    if (typeof value === 'object' && value !== null && (value as { channel?: unknown }).channel === 'nightly') return 'nightly'
  } catch {
    // No build info is normal for a source checkout.
  }
  return 'latest'
}

/**
 * Register the connector and every service it provides.
 * @param ctx - Host plugin context.
 * @param config - Bundle configuration resolved by the Loader.
 * @returns after the first heartbeat round settled.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const profileContext = ctx.get('profileContext')
  if (profileContext === undefined) {
    info(`inactive: this process has no profile (configSource=${config.configSource ?? 'default'})`)
    return
  }
  const major = osMajor(platform(), release())
  const builtOrigin = readBuildHubOrigin(MODULE_DIRECTORY, process.env)
  const build = {
    appVersion: readAppVersion(profileContext.installAnchor),
    appChannel: readChannel(MODULE_DIRECTORY),
    runtimeVersion: readAppVersion(profileContext.installAnchor),
    builtHubOrigin: builtOrigin,
    osLabel: osLabel(platform(), major),
    installId: randomUUID(),
    schemaDirectory: MODULE_DIRECTORY,
  }
  const credentials = ctx.credentials
  const webServer = ctx.get('webServer')
  const manager = ctx.get('pluginManager')
  const defaultModel = ctx.get('agentDefaultModel')
  const accountHost: AccountHost = {
    build,
    environment: process.env,
    credentials,
    registerRoute: (path, handler) => (webServer === undefined ? () => undefined : webServer.register({ kind: 'exact', path, handler })),
    hubOrigin: () => builtOrigin,
    readState: () => { throw new Error('hub-connector: state read before the connector was constructed') },
    writeState: () => { throw new Error('hub-connector: state write before the connector was constructed') },
    emit: (event) => {
      if (event === 'deepseek-account/signed-out' || event === 'deepseek-account/session-expired'
        || event === 'hub-connector/signed-in' || event === 'hub-connector/signed-out') {
        ctx.emit(event)
      }
    },
    changed: () => undefined,
    now: () => new Date(),
    random: size => randomBytes(size),
  }
  // The shell composes this from the installed `resources/runtime/hub-plugins`; a
  // source checkout without the packaged runtime leaves the baseline out.
  const bundledDirectory = (process.env.DSH_HUB_BUNDLED_DIR ?? '').trim()
  const host: ConnectorHost = {
    profile: profileContext.dir,
    build,
    environment: process.env,
    account: accountHost,
    pluginManager: manager === undefined ? undefined : manager satisfies PluginManagerAccess,
    ...bundledDirectory === '' ? {} : { bundledDirectory },
    ...profileContext.packageManager === undefined ? {} : { packageManager: profileContext.packageManager },
    hasDefaultModel: defaultModel === undefined ? undefined : async () => defaultModel.currentSelection().provider !== '',
    selectDefaultModel: defaultModel === undefined
      ? undefined
      : async (selection) => {
        await defaultModel.saveSelection({
          provider: selection.provider,
          model: selection.model,
          // The snapshot's level was validated against pi-ai's level list before it
          // reached here, so it is one of the adapter's own reasoning-effort ids.
          ...selection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: selection.reasoningEffort as ReasoningEffortId },
        })
      },
  }
  const connector = new HubConnector(host, account => new HubAccount(account))
  // The phone channel reads the grant instead of copying it: a sign-in, an
  // expiry, and an account switch are all reconciled by the next status read.
  // Nothing here dials a local Host address; the channel is outbound only.
  const channel = new ChannelController({
    profile: host.profile,
    lifecycle: new ChannelLifecycle({
      transport: createWebSocketTransport(),
      now: () => new Date(),
      random: () => Math.random(),
    }),
    readCredentials: () => {
      const grant = connector.grant
      return grant === undefined
        ? undefined
        : {
          hubOrigin: grant.hubOrigin,
          token: grant.token,
          nodeId: grant.deviceId,
          username: grant.user.username,
        }
    },
    now: () => new Date(),
    log: (message) => { warn(message) },
  })
  ctx.effect(() => () => { channel.dispose() }, 'hub-connector: phone channel')
  // The relay follows the channel's connection. The shared adapter package does the
  // frame translation; when it is missing the switch still works and every attempt
  // reports `adapter-unavailable` instead of silently parking phone frames.
  const nodeRemote = loadNodeRemote()
  const hostOrigin = ((): string => {
    const webServer = ctx.get('webServer')
    const port = webServer?.port
    if (webServer === undefined || port === undefined) return ''
    const host = webServer.host.includes(':') ? `[${webServer.host}]` : webServer.host
    return `${webServer.protocol}//${host}:${String(port)}`
  })()
  const hostCookie = createHostCookie({
    origin: () => hostOrigin,
    authenticatedUrl: origin => ctx.connection.authenticatedUrl(origin),
    authorizeIndex: (request, response) => ctx.connection.authorizeIndex(request, response),
  })
  ctx.effect(() => attachChannelRelay(channel, {
    deviceId: () => connector.grant?.deviceId,
    clientVersion: build.appVersion,
    ...nodeRemote === undefined || hostOrigin === '' ? {} : {
      probe: async () => await probeCapabilities(nodeRemote, {
        origin: hostOrigin,
        cookie: hostCookie,
        node: { id: connector.grant?.deviceId ?? 'desktop', name: build.osLabel, status: 'running' },
      }),
    },
    adapter: async (relayChannel) => {
      if (nodeRemote === undefined) {
        throw new Error('the shared adapter package @dsh-hub/dsh-node-remote is not installed')
      }
      if (hostOrigin === '') throw new Error('the Host webserver has no listening port yet')
      // A fresh channel starts with a fresh credential: the previous cookie may have
      // expired while no phone was connected.
      hostCookie.invalidate()
      return await createSharedAdapter(nodeRemote, {
        origin: hostOrigin,
        cookie: hostCookie,
        channel: relayChannel,
        nodeName: build.osLabel === '' ? 'DSH Hub desktop' : build.osLabel,
        hostStatus: () => 'running',
        log: (event, meta) => { info(`adapter ${event}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}`) },
      })
    },
    hostStatus: () => 'running',
    log: (message) => { info(message) },
  }), 'hub-connector: relay bridge')
  ctx.effect(() => ctx.provide('hubConnector', {
    version: '0.2.3',
    configSource: config.configSource ?? 'bundle',
    status: () => connector.status(),
    channel: () => channel.status(),
  }), 'hub-connector: service')
  ctx.effect(() => ctx.provide('hubAgentModes', connector.agentModes), 'hub-connector: agent modes')
  if (config.provideAccount !== false) {
    ctx.effect(() => ctx.provide('deepseekAccount', connector.account), 'hub-connector: account')
  } else {
    info('the account service stays with the upstream DeepSeek provider (advanced switch)')
  }
  ctx.effect(() => () => { connector.stop() }, 'hub-connector: teardown')
  // The Hub's own model routes reach the adapter as a managed set instead of an
  // overlay row, so the user's provider section stays theirs to edit. The adapter
  // can mount after this connector (or again after a reload); attaching here also
  // detaches when that service goes away.
  ctx.inject(['llmPiAiManaged'], (scope) => {
    const slot = scope.llmPiAiManaged.contribute('hub')
    let released = false
    scope.effect(() => {
      connector.attachManagedProviderSlot(slot)
      return () => {
        connector.attachManagedProviderSlot(undefined)
        // Releasing frees the source name: a recomposed connector contributes
        // `hub` again while this adapter instance keeps serving.
        if (released) return
        released = true
        try { slot.release() } catch (error) {
          info(`the hub model slot was already released: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }, 'hub-connector: managed model routes')
  })
  ctx.effect(() => registerClientRoutes(ctx, connector, channel), 'hub-connector: client routes')
  // A settled turn changes the wallet; refresh the account snapshot once it is over.
  ctx.on('agent/turn-stopping', () => { void connector.refreshSession() })
  ctx.on('hub-connector/signed-out', () => {
    connector.agentModes.clear()
    connector.clearAfterSignOut()
    // Consent belongs to the account that gave it: signing out closes the channel
    // and clears the binding before the next account can turn anything on.
    channel.refresh()
  })
  ctx.on('hub-connector/signed-in', () => {
    void connector.start()
    // A Hub sign-in is what makes the upstream introduction pointless, so the
    // record is written as soon as the account exists rather than at the next start.
    if (config.provideAccount !== false) finishUpstreamOnboarding(ctx)
  })
  if (config.provideAccount !== false) {
    // A device that signed in before this build already has a grant: settle the
    // introduction once the composition is complete, before the client boots.
    void ctx.root.loader.await().then(() => { finishUpstreamOnboarding(ctx) })
      .catch((error: unknown) => { info(`desktop introduction not settled: ${String(error)}`) })
  }
  info(`active version=0.2.3 configSource=${config.configSource ?? 'bundle'} arch=${arch()} origin=${builtOrigin === '' ? 'unset' : builtOrigin}`)
  // Installing bundles recomposes this plugin; the composition must settle before
  // startup can ask the plugin manager for another change.
  void ctx.root.loader.await().then(() => connector.start())
    .catch((error: unknown) => { info(`connector startup failed: ${String(error)}`) })
}
