#!/usr/bin/env bash
# Build the DSH Hub Windows x64 package with one command.
#
#   ./hub-build.sh              unpacked directory build (win-unpacked), unsigned
#   ./hub-build.sh --installer  NSIS installer instead of a directory; from WSL this
#                               compiles the installer interface on the Windows host
#   ./hub-build.sh --portable   additionally pack win-unpacked into a portable zip
#   ./hub-build.sh --check      validate configuration and toolchain only
#
# Every value that differs between builds is an environment variable; see
# HUB-FORK.md for the full list and for the build prerequisites.
#
#   DSH_HUB_ORIGIN          Hub HTTPS origin baked into the connector, the update feed,
#                           and the mandatory-update policy. Unset bakes the placeholder
#                           origin https://hub.example.com and warns; an explicitly empty
#                           value produces a local build with no Hub endpoints at all.
#   DSH_HUB_CN_MIRRORS=1    route every download through mainland mirrors (npmmirror for
#                           the npm registry, Electron and electron-builder binaries,
#                           Tsinghua TUNA for PowerShell and PyPI) instead of the
#                           upstream origins. Off by default: a build uses the origins
#                           the lock files name.
#   DSH_WINDOWS_POWERSHELL  powershell.exe that --installer runs from WSL. Defaults to
#                           powershell.exe on PATH, then the standard WSL path.
#
# Branding, icons, the application id, and the disabled upstream endpoints all come
# from apps/desktop/hub/branding.mjs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

SCRIPT="package:win:x64:dir"
PORTABLE=0
EXTRA=()
for argument in "$@"; do
  case "$argument" in
    --installer) SCRIPT="package:win:x64" ;;
    --portable) PORTABLE=1 ;;
    --check) EXTRA+=("--check") ;;
    *) EXTRA+=("$argument") ;;
  esac
done

# 1. Network. The upstream origins serve every download a build needs. A mainland
#    network reaches them slowly or not at all, so DSH_HUB_CN_MIRRORS switches the
#    npm registry, the Electron and electron-builder binary mirrors, and the seeded
#    runtime archives to mirrors; every pinned SHA-256 still verifies the bytes.
if [ "${DSH_HUB_CN_MIRRORS:-0}" = "1" ]; then
  export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
  export COREPACK_NPM_REGISTRY="https://registry.npmmirror.com"
  export npm_config_registry="https://registry.npmmirror.com"
  echo "hub-build: mainland mirrors enabled (DSH_HUB_CN_MIRRORS=1)"
fi
# Keep every cache inside the checkout: the run stays reproducible and writes
# nothing to the user's home directory.
export NODE_ENV=development
export COREPACK_HOME="$ROOT/.corepack"
export PNPM_HOME="$ROOT/.desktop-build/pnpm-home"
# Caches live beside the checkout, not inside it: electron-builder extracts CommonJS
# helpers into its cache, and the repository's `"type": "module"` would make Node
# treat them as ESM (`require is not defined in ES module scope`).
export BUILD_CACHE="$(cd "$ROOT/.." && pwd)/.hub-build-cache"
export XDG_CACHE_HOME="$BUILD_CACHE/xdg-cache"
export XDG_CONFIG_HOME="$BUILD_CACHE/xdg-config"
export XDG_DATA_HOME="$BUILD_CACHE/xdg-data"
export XDG_STATE_HOME="$BUILD_CACHE/xdg-state"
export ELECTRON_BUILDER_CACHE="$BUILD_CACHE/electron-builder"
STORE_DIR="$BUILD_CACHE/pnpm-store"

# 2. Hub origin baked into the connector (build-info.json), the update feed, and the
#    mandatory-update policy. A release without it starts with no Hub to talk to and
#    the shell aborts on first launch, so an unset variable bakes the documented
#    placeholder and says so; `DSH_HUB_ORIGIN=` (empty) is the deliberate local build.
if [ -z "${DSH_HUB_ORIGIN+x}" ]; then
  export DSH_HUB_ORIGIN="https://hub.example.com"
  echo "hub-build: DSH_HUB_ORIGIN is unset; baking the placeholder $DSH_HUB_ORIGIN." >&2
  echo "hub-build: set DSH_HUB_ORIGIN to your own Hub origin, or DSH_HUB_ORIGIN= for a local build with no Hub." >&2
fi
# One source of truth for the accepted form: branding.mjs validates the value and
# returns the normalized origin, so `https://hub.example.com/` and a bad value both
# behave the same way here as they do at packaging time.
DSH_HUB_ORIGIN="$(node --input-type=module -e "import { brandedHubOrigin } from './apps/desktop/hub/branding.mjs'; process.stdout.write(brandedHubOrigin(process.env))")"
export DSH_HUB_ORIGIN
if [ -z "$DSH_HUB_ORIGIN" ]; then
  echo "hub-build: no Hub origin; every Hub endpoint stays disabled in this build"
else
  echo "hub-build: Hub origin $DSH_HUB_ORIGIN"
fi

# 3. Package manager pinned by packageManager in package.json.
corepack prepare pnpm@11.28.5 --activate >/dev/null

# 4. Machine settings: the only file-owned values a Hub build needs. Branding,
#    the application id, and every disabled endpoint live in hub/branding.mjs.
if [ ! -f apps/desktop/.env.windows ]; then
  {
    echo '# Generated by hub-build.sh. Product identity lives in apps/desktop/hub/branding.mjs.'
    echo 'DSH_DESKTOP_APP_ID=tech.dshhub.desktop'
    if [ "${DSH_HUB_CN_MIRRORS:-0}" = "1" ]; then echo 'DSH_DESKTOP_NPM_REGISTRY=https://registry.npmmirror.com'; fi
  } > apps/desktop/.env.windows
fi

# 5. Dependencies, once per checkout.
if [ ! -d node_modules/.pnpm ]; then
  corepack pnpm install --frozen-lockfile --store-dir "$STORE_DIR"
fi

# 6. Primary-runtime archives: the upstream preparation fetches nodejs.org, the
#    astral-sh GitHub release, and files.pythonhosted.org. The mainland mirrors are
#    slow or unreachable from some networks, so seed the SHA-256-keyed cache from
#    them first when the mirror mode is on; verified bytes are identical, so the
#    lock file stays authoritative.
if [ "${DSH_HUB_CN_MIRRORS:-0}" = "1" ]; then
  DSH_DESKTOP_TARGET_PLATFORM=win32 DSH_DESKTOP_TARGET_ARCH=x64 \
    node apps/desktop/hub/seed-runtime-cache.mjs
fi

# 7. NSIS, signing, and the payload smoke all need Windows. Everywhere else the run
#    packs the unpacked directory only (see DSH_HUB_CROSS_PACKAGE). An installer asks
#    the Windows machine for the three inputs a cross build cannot produce: the NSIS
#    interface compiled by MSVC, the Windows 7-Zip the installer embeds, and the
#    uninstaller, which is read out of its generation installer (hub/nsis-cross-package.mjs).
HOST="$(uname -s)-$(uname -m)"
case "$HOST" in
  Linux-x86_64) export DSH_HUB_CROSS_PACKAGE=1 ;;
esac
windows_powershell() {
  if [ -n "${DSH_WINDOWS_POWERSHELL:-}" ]; then printf '%s' "$DSH_WINDOWS_POWERSHELL"; return; fi
  if command -v powershell.exe >/dev/null 2>&1; then command -v powershell.exe; return; fi
  printf '%s' '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
}
prepare_windows_installer() {
  local powershell script
  powershell="$(windows_powershell)"
  if [ ! -x "$powershell" ]; then
    echo "hub-build: --installer needs Windows PowerShell at $powershell; set DSH_WINDOWS_POWERSHELL." >&2
    exit 2
  fi
  command -v wslpath >/dev/null || { echo "hub-build: --installer needs wslpath to hand paths to Windows." >&2; exit 2; }
  script="$(wslpath -w "$ROOT/apps/desktop/hub/build-installer-windows.ps1")"
  echo "hub-build: compiling the NSIS installer interface on Windows"
  "$powershell" -NoProfile -ExecutionPolicy Bypass -File "$script"
  # Tells the packaging configuration that the interface assets and the uninstaller
  # step are already satisfied, so it must not compile them or run Wine.
  export DSH_HUB_INSTALLER_UI=1
}
if [ "$SCRIPT" = "package:win:x64" ]; then
  case "$HOST" in
    MINGW*|MSYS*|CYGWIN*) : ;;
    Linux-x86_64) prepare_windows_installer ;;
    *) echo "hub-build: an installer requires a Windows x64 host or a Windows machine reachable from WSL." >&2; exit 2 ;;
  esac
fi
mkdir -p .desktop-build/hub-logs
RUN_LOG=".desktop-build/hub-logs/package-$(date +%Y%m%d-%H%M%S).log"

# 8. Product identity the browser build embeds. The client bundle carries the
#    document title (`DSH_CLIENT_TITLE`, the browser tab and window title); its
#    official default is the upstream product name, so a Hub build hands over its
#    own. `branding.mjs` stays the only place the name is written.
PRODUCT_NAME="$(node --input-type=module -e "import { DESKTOP_BRANDING as b } from './apps/desktop/hub/branding.mjs'; console.log(b.productName)")"
export DSH_CLIENT_TITLE="$PRODUCT_NAME"

# 9. Package. The repository build (build:official) and every preparation stage run
#    inside this command; electron-builder writes win-unpacked under
#    apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts.
STARTED_AT=$(date +%s)
set -x
corepack pnpm --filter @deepseek-ai/dsh-desktop run "$SCRIPT" -- --unsigned "${EXTRA[@]}" 2>&1 | tee "$RUN_LOG"
set +x
ELAPSED=$(( $(date +%s) - STARTED_AT ))

echo
echo "hub-build: log $RUN_LOG"
echo "hub-build: elapsed $((ELAPSED / 60))m$((ELAPSED % 60))s"
UNPACKED="apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked"

# 10. Branding assertion. The product is DSH Hub: no user-visible string may name
#     the upstream product, and every accepted upstream mention is classified in
#     hub/brand-audit-allow.json. Source mode reads the dictionaries this build
#     ships; artifact mode reads the packaged client bundles of the composed rows.
echo "hub-build: auditing user-visible branding"
node apps/desktop/hub/audit-brand.mjs

case " ${EXTRA[*]-} " in
  *" --check "*) echo "hub-build: configuration check only; no artifact was produced" ;;
  *)
    if [ ! -d "$UNPACKED/resources" ]; then exit 0; fi
    echo "hub-build: artifact $ROOT/$UNPACKED"
    # Payload assertions. The distribution policy forbids redistributing the Claude
    # Code binaries, the Claude Agent SDK, or claude.exe; both pilots pull their
    # binaries per platform at install time, so any copy here is a licensing
    # regression. The Anthropic REST SDK (@anthropic-ai/sdk) is a model-provider
    # HTTP client and stays allowed.
    PAYLOAD="$UNPACKED/resources"
    # The bundled plugin archives are named after the plugins they carry, so they are
    # excluded from the file-name match and inspected as archives below instead.
    # `|| true`: an empty match set is the expected result and must not fail the script.
    PILOTS=$(find "$PAYLOAD" \( -iname '*claude*' -o -iname '*codex*' \) -not -path "$PAYLOAD/runtime/hub-plugins/*" -print 2>/dev/null | head -20 || true)
    ANTHROPIC=$(find "$PAYLOAD" -path '*/@anthropic-ai/*' -print 2>/dev/null | grep -v '/@anthropic-ai/sdk' | head -20 || true)
    if [ -n "$PILOTS" ] || [ -n "$ANTHROPIC" ]; then
      echo "hub-build: refused: the payload redistributes pilot binaries:" >&2
      printf '%s\n' "$PILOTS" "$ANTHROPIC" | sed '/^$/d' >&2
      exit 1
    fi
    # An archive may carry only sources: a per-platform binary is pulled at install
    # time, and an archive that already contains one would ship it inside the app.
    ARCHIVE_BINARIES=$(for archive in "$PAYLOAD"/runtime/hub-plugins/*.tgz; do
      [ -f "$archive" ] || continue
      tar -tzf "$archive" 2>/dev/null | grep -Ei '\.(exe|dll|node|so|dylib|pdb)$' | sed "s|^|$(basename "$archive"): |"
    done | head -20 || true)
    if [ -n "$ARCHIVE_BINARIES" ]; then
      echo "hub-build: refused: a bundled plugin archive carries a binary:" >&2
      printf '%s\n' "$ARCHIVE_BINARIES" >&2
      exit 1
    fi
    # The Windows package carries the bundled PowerShell and the Hub plugin archives.
    if [ ! -f "$PAYLOAD/runtime/pwsh/7.6.7/pwsh.exe" ]; then
      echo "hub-build: refused: resources/runtime/pwsh/7.6.7/pwsh.exe is missing" >&2
      exit 1
    fi
    if [ ! -f "$PAYLOAD/runtime/hub-plugins/hub-plugins.json" ]; then
      echo "hub-build: refused: resources/runtime/hub-plugins/hub-plugins.json is missing" >&2
      exit 1
    fi
    # Every Hub-facing default derives from the connector's baked origin.
    CONNECTOR=$(find "$PAYLOAD/runtime/hub-plugins" -maxdepth 1 -name 'dsh-hub-hub-connector-*.tgz' | head -1)
    BAKED=$(tar -xzOf "$CONNECTOR" package/build-info.json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).hubOrigin??"")}catch{}})')
    if [ "$BAKED" != "$DSH_HUB_ORIGIN" ]; then
      echo "hub-build: refused: the connector's build-info.json carries hubOrigin '$BAKED', expected '$DSH_HUB_ORIGIN'" >&2
      exit 1
    fi
    # The installer's bundled plugin set and model snapshot must be present and intact.
    BUNDLED="$PAYLOAD/runtime/hub-plugins"
    if [ ! -f "$BUNDLED/bundled-plugins.json" ] || [ ! -f "$BUNDLED/bundled-models.json" ]; then
      echo "hub-build: refused: resources/runtime/hub-plugins/bundled-plugins.json or bundled-models.json is missing" >&2
      exit 1
    fi
    # A fresh checkout bundles no third-party plugin, so an empty manifest is valid.
    BUNDLED_LIST=$(node --input-type=module -e '
      import { createHash } from "node:crypto"
      import { readFileSync } from "node:fs"
      const directory = process.argv[1]
      const declared = JSON.parse(readFileSync(`${directory}/bundled-plugins.json`, "utf8"))
      if (!Array.isArray(declared)) {
        console.error("hub-build: the bundled plugin manifest must be an array")
        process.exit(1)
      }
      for (const plugin of declared) {
        let bytes
        try { bytes = readFileSync(`${directory}/${plugin.file}`) } catch {
          console.error(`hub-build: ${plugin.file} is missing next to bundled-plugins.json`)
          process.exit(1)
        }
        const digest = createHash("sha256").update(bytes).digest("hex")
        if (digest !== plugin.sha256) {
          console.error(`hub-build: ${plugin.file} has SHA-256 ${digest}, the manifest declares ${plugin.sha256}`)
          process.exit(1)
        }
        process.stdout.write(`${plugin.package}\t${plugin.file}\n`)
      }
    ' "$BUNDLED") || exit 1
    while IFS=$'\t' read -r package file; do
      [ -n "${file:-}" ] || continue
      # The listing is read once: `tar | grep -q` would make grep close the pipe and
      # tar fail with SIGPIPE, which `set -o pipefail` turns into a false refusal.
      if ! listing=$(tar -tzf "$BUNDLED/$file" 2>/dev/null); then
        echo "hub-build: refused: $file cannot be read as a tar archive" >&2
        exit 1
      fi
      if ! grep -qx 'package/package.json' <<< "$listing"; then
        echo "hub-build: refused: $file is not an npm package archive" >&2
        exit 1
      fi
      # A hosted codex package ships its license material.
      if [ "$package" = '@local/dsh-codex-pilot' ]; then
        for member in package/LICENSE package/NOTICE; do
          if ! grep -qx "$member" <<< "$listing"; then
            echo "hub-build: refused: $file is missing $member" >&2
            exit 1
          fi
        done
      fi
    done <<< "$BUNDLED_LIST"
    echo "hub-build: payload assertions passed (Hub origin ${BAKED:-none}; no pilot binaries; bundled pwsh, Hub plugins, $(printf '%s' "$BUNDLED_LIST" | grep -c . || true) bundled plugin archives, and the model snapshot present)"
    # The client bundles the composition loads, as this build emitted them.
    node apps/desktop/hub/audit-brand.mjs --artifacts packages/client
    du -sh "$UNPACKED" "$UNPACKED/resources/runtime" "$UNPACKED/resources/app.asar" "$UNPACKED/resources/app.asar.unpacked" 2>/dev/null
    if [ "$PORTABLE" = "1" ]; then
      # The unpacked directory is already a complete, self-contained application;
      # the zip only adds a folder wrapper and a usage note. Updates are manual.
      VERSION=$(node -p "require('./apps/desktop/package.json').version")
      PRODUCT="$PRODUCT_NAME"
      ZIP="$(dirname "$UNPACKED")/${PRODUCT// /-}-${VERSION}-win-x64-portable-unsigned.zip"
      python3 apps/desktop/hub/make-portable-zip.py "$UNPACKED" "$ZIP" "$PRODUCT" "$VERSION"
      ( cd "$(dirname "$ZIP")" && sha256sum "$(basename "$ZIP")" )
    fi
    if [ "$SCRIPT" = "package:win:x64" ]; then
      # The installer is the deliverable here; name it with its size and digest so a
      # receiver can verify the file without asking which run produced it.
      INSTALLER=$(find "$(dirname "$UNPACKED")" -maxdepth 1 -name 'DSH Hub Setup *.exe' -newermt "@$STARTED_AT" -print -quit)
      if [ -z "$INSTALLER" ]; then
        echo "hub-build: refused: no installer was written next to $UNPACKED" >&2
        exit 1
      fi
      echo "hub-build: installer $ROOT/$INSTALLER"
      echo "hub-build: installer bytes $(stat -c%s "$INSTALLER")"
      ( cd "$(dirname "$INSTALLER")" && sha256sum "$(basename "$INSTALLER")" )
    fi
    ;;
esac
