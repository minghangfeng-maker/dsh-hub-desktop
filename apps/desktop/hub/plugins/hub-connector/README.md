# @dsh-hub/hub-connector

English | [中文](README.zh.md)

The desktop's Hub connector: it provides the account service, the device
identity and report, the manifest applier, and the `hubAgentModes` service the
Claude Code and Codex pilots consume.

The installer ships this package as a core profile plugin, so it is never
delivered by the Hub and never uninstalled by it.

## Startup order

`apply` waits for the composition to settle, then `HubConnector.start()`:

1. **The installer's bundled plugins** (see below) — before any account exists.
2. The agent-mode cache, then the stored device grant. Without a grant the run
   stops here: the device waits for a sign-in and the loops start on the
   `hub-connector/signed-in` event.
3. With a grant: the account loops, the managed model set, one report, one manifest
   pull — the login sync round. It ends after the background dependency pass has
   settled, and the connector timestamps that end in its state file. Reports repeat
   on the interval the Hub asks for; the manifest is pulled again whenever the Hub's
   answer names a newer revision.

## Hub address

Every Hub request goes to the address the user entered on the account page, or —
while they entered nothing — to the address this build carries: `DSH_HUB_ORIGIN`
at launch, otherwise the `hubOrigin` recorded in the package's `build-info.json`.
The installer no longer seeds the state file with that address, so a newly
installed build moves every install whose user never typed one.

`settings.hubOriginOverride` holds only what the user typed, normalized; an empty
value means "follow the build". `loadState` ignores the pre-rename
`settings.hubOrigin` key: it held the origin of the build that wrote it, which no
user could edit through the UI, so the next write drops it.

`POST /hub-connector/api/settings` accepts `{hubOrigin}`, where an empty string
restores the build-time origin. A change of address is a change of Hub: with a
stored grant the connector signs out first — revoking the device token at the Hub
that issued it and clearing the relay and pilot keys — and stores the new address
only after that, so the old token can never reach the new origin. Revocation is
bounded to five seconds, because a Hub the user is leaving must not stall the
switch. The route answers `400 {error: 'invalid-origin'}` for an address the
transport rules reject (HTTPS anywhere, plain HTTP on loopback only) and `409
{error: 'sign-in-in-progress'}` while a sign-in attempt is still bound to the
current origin. Typing the build's own address stores the empty override, and a
change that leaves the effective address alone does not sign out.

`GET /hub-connector/api/state` reports the effective address (`hubOrigin`), the
stored override (`hubOriginOverride`), and the build's own address
(`builtHubOrigin`); the account card's Hub address row renders all three.

## Hub model routes

The Hub's model configuration never enters `cordis.hub.patch.yml`. It is a managed
provider set: the delivered `llm-pi-ai` and `agent-default-model` fragments are
extracted, persisted as `managedModels` in `state.json`, and registered through the
adapter's `llmPiAiManaged` service. The overlay would outrank the profile patch,
so a model row there would make every personal provider edit look overridden; with
the routes registered in the adapter, Hub models and the user's own routes serve
side by side and only the user's section is written by the Models page.

A set is adopted only when the adapter accepts it: the replacement is validated and
checked against the user's routes and other contributors before anything moves. A
refused delivery keeps the previous set and the user's configuration serving, reports
`config_write_failed` with a partial apply, and puts the reason on the account card.
Signing out withdraws the routes but keeps the persisted set, so the next sign-in
restores it before the Hub is reachable; the personal routes are never touched. The
delivered route and model ids are preserved because old sessions reference them.

`needsRestart` in a manifest is the activation condition of a change that happened:
the applier raises a restart only for an install, upgrade, toggle, or removal whose
operation succeeded this round, or when the plugin manager reports
`restart-required`. Replaying a manifest whose plugins are already in place raises
nothing.

On an upgraded install the desktop Host runs `migrateHubOverlayModels` before it
composes the profile: the two model rows leave the overlay, their content is parked
in `desktop-hub/legacy-models.json`, and the connector imports that file once and
removes it. Every other row, the header, and the reserved proxy block stay
byte-for-byte; a repeated pass changes nothing, and a file the migration cannot read
is reported and left alone.

## Restart notice

Applying a manifest rewrites `cordis.hub.patch.yml`, which the Host reads as its last
patch layer when it composes the profile. A delivery that changes the overlay, installs
a plugin that declares `needsRestart`, or leaves a removal pending therefore takes
effect at the next start, and the connector cannot restart the application. It records
the need instead: `state.json` gains `restart` (reason, timestamp, and the Host process
that wrote it) and `syncedAt` (the end of the round that produced it).

The desktop shell reads that file, offers the restart once the round has settled, and
performs it — including the task inspection and request drain a restart needs. A record
written by an earlier Host process is dropped on the next start, because that start is
the restart it asked for; signing out drops it too, because the overlay it named is
gone. The account card can ask for the restart directly through
`POST /hub-connector/api/restart`, which stamps `requestedAt` on the same record.

Generating the model routes and the search rows never raises the notice by itself: the
model set is registered live, and the search rows reach the composition at the next
start without the user being asked.

## Phone access

The switch that lets the user's phone reach this computer belongs to the machine,
so it lives in this package: the device token it connects with is the account grant
the connector already holds.

- **Off until asked.** `<profile>/desktop-hub/channel.json` holds the switch and the
  account it was turned on for, and nothing else. A missing, unreadable, or
  older-versioned file reads as off, and a switch without a binding reads as off too.
  Turning it off closes the socket; it does not connect and refuse.
- **Bound to one account.** The record names the Hub node id, the Hub username, and
  the Hub origin. A grant naming a different device, username, or origin replaces the
  binding and leaves the switch off; signing out clears the binding and turns the
  switch off, so the next account cannot inherit the previous one's consent.
- **One outbound socket.** `src/channel/lifecycle.ts` owns at most one connection and
  retries it with jittered exponential backoff (1s → 30s). It opens nothing while the
  switch is off or the account is unbound, and it drops a close event from a
  superseded attempt. Frames stay opaque at this layer: `attachFrames` is the seam the
  mobile protocol attaches to.
- **No local address, no local credential.** The transport reaches the Hub origin with
  the device token; nothing here dials the Host, and the token never reaches the
  renderer, a log line, or the status route. A Host whose profile does not carry `ws`
  reports `failed/transport-unavailable` and leaves the rest of this connector serving.
- **Status surface.** `GET /hub-connector/api/channel` reports the switch, phase
  (`off`, `waiting-sign-in`, `connecting`, `online`, `retry`, `failed`), bound account,
  node id, connection time, attempt count, and next retry. `POST` with `{enabled}`
  changes the switch; `GET /hub-connector/api/state` carries the same object under
  `channel` so the account card reads everything once.

## Bundled plugins

`apps/desktop/hub/bundled-plugins.json` declares the third-party plugins every
installation carries (`package`, `version`, `file`, `sha256`, `level`). The
packaging step copies each archive beside that manifest into
`resources/runtime/hub-plugins/`, and the shell passes that directory to the
Host as `DSH_HUB_BUNDLED_DIR`.

The **shell** installs them, before the Host starts
(`activateBundledThirdPartyPlugins` in `apps/desktop/src/hub-plugins.ts`): a
first start must already run every bundled plugin, and installing from inside
the running Host reloads the composition once per package, which left the later
packages installed but not loaded. The shell verifies each archive's digest,
extracts it into the profile, records the `file:` dependency, and enables the
bundle.

The connector then compares the declarations with the profile on each start:

- installed version equal → record `source: 'bundled'` and report it;
- absent, or bundled version higher → fall back to installing through the plugin
  manager (`file:` spec staged under `<profile>/desktop-hub/bundled/`), so a
  profile the shell has not seen yet still converges;
- installed version higher → leave the profile alone;
- `level: 'core'` stays enabled; the user may disable a `default`/`optional` one;
- a manifest that names the package outranks the baseline: its version installs,
  its enabled flag applies, and its `uninstall` entry keeps the package out of
  the baseline on later starts (recorded in `desktop-hub/state.json` as
  `bundledRemovals`). A newer later manifest naming the package again installs
  it from the Hub;
- a manifest that names a lower version than the installed bundled one does not
  downgrade: the record keeps the installed version with `source: 'bundled'`,
  and the report says so.

Sign-in is irrelevant: the archives are local, so a device that never reaches the
Hub still has its baseline plugins.

## Bundled model snapshot

`apps/desktop/hub/bundled-models.json` is the Hub's own `llm-pi-ai` fragment for
the desktop default preset, minus the per-device members (`baseURL`, `apiKeyEnv`),
plus `agentDefaultModel` (`schemaVersion: 2`; a Hub exports it for the devices it
serves). The file in this repository is a sample with placeholder route ids; replace
it with an export from your own Hub before shipping (see `HUB-FORK.md`). Model ids
are relay route ids (`<model>@<channel>`); the file carries no key, token, or
endpoint.

When a manifest has not delivered an `llm-pi-ai` fragment yet, the connector asks
the relay `GET /v1/models` with the device's own relay key and renders every
snapshot provider with only the models this device can reach: an empty provider
disappears, `baseURL` becomes `<hubOrigin>/v1`, `apiKeyEnv` stays the
`HUB_MK_HUB` reference, and the provider's other members (display copy, `api`,
thinking level, model parameters, `compat`) ride through unchanged. The default
selection is `agentDefaultModel` when its provider and model survived, otherwise
the first rendered model with its provider's thinking level. A delivered
`llm-pi-ai` fragment replaces the generated set. Neither is written to the overlay;
both become the managed provider set described above. The recommended default is
saved only while the user has chosen nothing, so a personal selection survives every
sync and restart. The version-1 flat example layout is still read as one `hub` provider.

## Files the connector owns

| Path | Contents |
|---|---|
| `<profile>/cordis.hub.patch.yml` | the overlay the desktop Host applies last: delivered non-model fragments, the search rows, the proxy block |
| `<profile>/desktop-hub/state.json` | settings, server-issued device id, apply record, managed plugin records, the Hub model set (`managedModels`), pending removals, bundled removals, last report body, the pending restart with its sync round |
| `<profile>/desktop-hub/legacy-models.json` | model rows an upgraded Host moved out of an old overlay; imported once, then removed |
| `<profile>/desktop-hub/cache/<sha256>/` | verified manifest archives (newest four kept) |
| `<profile>/desktop-hub/bundled/` | staged copies of the installer's plugin archives |

No credential is written to any of them: device tokens, relay keys, and
agent-mode keys live in the credential store.
