---
kind: upgrade-guide
description: "The DSH Hub desktop build moves its model routes out of the Hub overlay into an adapter-managed set, so the Models page can save personal providers."
---

# Hub model routes leave `cordis.hub.patch.yml`

English | [中文](guide.zh.md)

## Change

The DSH Hub desktop build used to deliver the Hub's model routes as the whole `llm-pi-ai` row in `<profile>/cordis.hub.patch.yml`, which the Host applies as its last `--patch` layer. That row outranked the profile patch, so saving a personal provider under Settings → Models failed with `Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay`, and a saved default model could be overwritten by the same overlay.

This release registers the delivered routes through the adapter's `llmPiAiManaged` service instead and keeps them in `<profile>/desktop-hub/state.json` as `managedModels`. Hub models still reach requests through the Hub relay; personal providers call their own endpoints with local credentials. The `agent-default-model` row also leaves the overlay, so `cordis.patch.yml` now owns the default selection. Who is affected: anyone running the desktop build with Hub-delivered models, and any tooling that reads `cordis.hub.patch.yml` expecting the `llm-pi-ai` or `agent-default-model` rows.

## Migration

1. Install or unpack the new desktop build and start it once. Before composing the profile, the Host moves both model rows out of `cordis.hub.patch.yml`, keeps every other row and the `hubProxy` block, and saves the previous file as `cordis.hub.patch.yml.bak-<timestamp>`. No manual edit is needed; the next start performs nothing.
2. Confirm the result in the profile: `cordis.hub.patch.yml` no longer contains `- id: llm-pi-ai` or `- id: agent-default-model`, and `desktop-hub/state.json` carries a `managedModels` object with an `origin` and `deviceId`.
3. Open Settings → Models. Hub providers show the "From your Hub" tag without edit or delete buttons; personal providers keep both, and a newly added custom API saves and serves from its own endpoint.
4. If a personal provider already uses a route id the Hub now delivers, the Hub update is refused (`applyState: partial`, `applyErrorCode: config_write_failed`) and the account card names the conflict. Rename the personal route; the next manifest pull retries the same revision without waiting for an operator.
5. To roll back, quit the app, restore the newest `cordis.hub.patch.yml.bak-*` over `cordis.hub.patch.yml`, and remove `managedModels` from `desktop-hub/state.json`. An older client then owns the model rows again, and personal providers stay in `cordis.patch.yml` but are hidden by the restored overlay.
