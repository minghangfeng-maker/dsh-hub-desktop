# Vendored adapter package

`@dsh-hub/dsh-node-remote` is the mobile frame adapter published from the public
`dsh-hub` repository (`packages/dsh-node-remote`). This directory holds the exact
tarball that package published, so a build can materialize the adapter **offline**
and the connector archive can carry it:

- `package.json` declares `"@dsh-hub/dsh-node-remote": "0.2.2"` and lists the adapter
  in `bundleDependencies`; the packed connector archive ships the adapter and `ws`
  under `node_modules/` because a profile unpacks Hub plugins without a package manager.
- `vendor/` itself is **not** part of the delivered archive: only `SHA256SUMS` and this
  note are listed in `files`. The tarball is build-time provenance for the bundled copy.

Current version: **0.2.2**, the package `@dsh-hub/dsh-node-remote` at `0.2.2` from
`github.com/dsh-hub/dsh-hub`, `packages/dsh-node-remote`: channel v2 with the mux frame
cap at 64 MiB, a temporary follow that carries the assistant stream, Host stop reasons
in error copy, `session-state` snapshots, the opt-in `parkInteractions` mode, and phone
sessions created in the Host's default workspace. The package `CHANGELOG.md` records
what 0.2.2 adds over 0.2.1; every addition is backward compatible. SHA-256
`0a091d8fab315ca267549edea2b77fc9b9e334e9aa4d81f5a83d43c3edcc0856`.

## Building this checkout

The desktop build does not install the connector's dependencies for you: the packaging
step reads `hub-connector/node_modules` and fails when a declared bundled dependency is
missing. Materialize the two bundled dependencies from this tarball and the workspace
install before packaging:

```bash
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT/apps/desktop/hub/plugins/hub-connector"

# 1. The adapter, from the vendored tarball (verify the checksum first).
( cd vendor && sha256sum -c SHA256SUMS )
rm -rf node_modules/@dsh-hub/dsh-node-remote
mkdir -p node_modules/@dsh-hub
tar -xzf vendor/dsh-hub-dsh-node-remote-0.2.2.tgz -C /tmp
mv /tmp/package node_modules/@dsh-hub/dsh-node-remote

# 2. ws, at the version the connector declares (workspace virtual store).
rm -rf node_modules/ws
cp -a "$(ls -d "$ROOT"/node_modules/.pnpm/ws@8.21.3/node_modules/ws | head -1)" node_modules/ws

node -e "console.log(require('./node_modules/@dsh-hub/dsh-node-remote/package.json').version)"  # 0.2.2
```

`node_modules/` inside the plugin is git-ignored build state, like the rest of the
checkout's install tree.

## Replacing the adapter

- Check the archive against `SHA256SUMS` and replace file and checksum together when
  the package republishes; also update the version in `package.json`. The connector
  reports `bye{adapter-unavailable}` when the package is missing or fails to load, so a
  stale copy degrades visibly instead of silently.
- Do not point the dependency at a development path: the installer must be able to
  install this package with no network and no checkout of the repository that builds
  the adapter.
