#!/usr/bin/env bash
# Builds and installs engined as a systemd --user unit. Running this again
# is the update: it re-bundles, re-syncs engines/, rewrites the unit, and
# restarts. There is no other install or update path.
set -euo pipefail

: "${HOME:?HOME must be set}"

# Same resolution as src/paths.ts: the env var when set and non-empty, else
# the fallback under $HOME. All three XDG vars are unset on this box, so the
# fallback is the normal path, not the edge -- and skipping it would resolve
# to "/engined" off an empty XDG_DATA_HOME, installing at the filesystem root.
xdg() {
  local var="$1" fallback="$2"
  local val="${!var:-}"
  if [[ -n "$val" ]]; then
    printf '%s\n' "$val"
  else
    printf '%s\n' "$HOME/$fallback"
  fi
}

DATA_HOME="$(xdg XDG_DATA_HOME .local/share)"
STATE_HOME="$(xdg XDG_STATE_HOME .local/state)"
CONFIG_HOME="$(xdg XDG_CONFIG_HOME .config)"

if [[ -z "$DATA_HOME" || "$DATA_HOME" == "/" || -z "$STATE_HOME" || "$STATE_HOME" == "/" ]]; then
  echo "install.sh: resolved data/state home is empty or filesystem root, refusing" >&2
  exit 1
fi

INSTALL_DIR="$DATA_HOME/engined"
STATE_DIR="$STATE_HOME/engined"
UNIT_DIR="$CONFIG_HOME/systemd/user"
UNIT_PATH="$UNIT_DIR/engined.service"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BUN_PATH="$(command -v bun)" || {
  echo "install.sh: bun not found on PATH" >&2
  exit 1
}
BUNX_PATH="$(command -v bunx)" || {
  echo "install.sh: bunx not found on PATH" >&2
  exit 1
}

COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

# The install dir is deliberately not a git tree, so GET /v1/engines can only
# report the revision it was built from if it's baked in now. ENGINED_COMMIT
# is a bare global; unset (no --define) it falls through to "unknown" at the
# call site rather than throwing.
bun build "$REPO_ROOT/src/main.ts" \
  --target=bun \
  --define ENGINED_COMMIT="\"$COMMIT\"" \
  --outfile "$BUILD_DIR/main.js"

mkdir -p "$INSTALL_DIR" "$STATE_DIR" "$STATE_DIR/bun-install" "$STATE_DIR/tmp"

# main.js is one file, fully overwritten every run; engines/ syncs with
# --delete because a spec directory removed from the repo has to disappear
# from the install too, or the engine it backed stays configured against a
# stale copy instead of reporting unavailable.
cp "$BUILD_DIR/main.js" "$INSTALL_DIR/main.js"
rsync -a --delete "$REPO_ROOT/engines/" "$INSTALL_DIR/engines/"

mkdir -p "$UNIT_DIR"
sed \
  -e "s|@BUN_PATH@|$BUN_PATH|g" \
  -e "s|@BUNX_PATH@|$BUNX_PATH|g" \
  "$REPO_ROOT/scripts/engined.service.in" >"$UNIT_PATH"

systemctl --user daemon-reload
systemctl --user restart engined.service
