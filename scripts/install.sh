#!/usr/bin/env bash
# Builds and installs engined as a systemd --user unit. Running this again
# is the update: it re-bundles, re-syncs engines/, rewrites the unit, and
# restarts. There is no other install or update path.
set -euo pipefail

: "${HOME:?HOME must be set}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

# The unit-facing spelling of a resolved directory: %h/... when it falls
# under $HOME (the systemd specifier, not a literal path, so the same unit
# works if rendered for another user), or the literal path when it doesn't --
# a directory outside $HOME has no %h spelling at all.
to_unit_path() {
  local p="$1"
  if [[ "$p" == "$HOME/"* ]]; then
    printf '%%h/%s\n' "${p#"$HOME"/}"
  else
    printf '%s\n' "$p"
  fi
}

resolve_paths() {
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

  UNIT_INSTALL_DIR="$(to_unit_path "$INSTALL_DIR")"
  UNIT_STATE_DIR="$(to_unit_path "$STATE_DIR")"
}

# The %h rewrite in to_unit_path is the whole guarantee that the install and
# state dirs stay user-independent in the unit; this is what catches a future
# template edit that bypasses it before the file ever lands on disk. BUN_PATH
# and BUNX_PATH are deliberately excluded -- they're resolved absolute binary
# paths and are allowed to live under $HOME, so checking the whole rendered
# file would false-positive on every install where bun does.
assert_unit_names_no_user() {
  local out="$1" user exec_line daemon_path
  user="$(id -un)"

  if [[ "$UNIT_INSTALL_DIR" == "$HOME"* || "$UNIT_INSTALL_DIR" == *"$user"* ||
    "$UNIT_STATE_DIR" == "$HOME"* || "$UNIT_STATE_DIR" == *"$user"* ]]; then
    echo "install.sh: install/state dir still names \$HOME or the user, refusing to render" >&2
    exit 1
  fi

  exec_line="$(grep '^ExecStart=' "$out")"
  daemon_path="${exec_line#*ExecStart=* }"
  if [[ "$daemon_path" == "$HOME"* || "$daemon_path" == *"$user"* ]]; then
    echo "install.sh: ExecStart's daemon path names \$HOME or the user, refusing" >&2
    exit 1
  fi

  if grep -E '^(ReadWritePaths|Environment=BUN_INSTALL|Environment=BUN_TMPDIR)=' "$out" |
    grep -qE -- "$HOME|$user"; then
    echo "install.sh: ReadWritePaths/BUN_INSTALL/BUN_TMPDIR name \$HOME or the user, refusing" >&2
    exit 1
  fi
}

render_unit_file() {
  local out="$1"
  : "${BUN_PATH:?BUN_PATH must be resolved before rendering}"
  : "${BUNX_PATH:?BUNX_PATH must be resolved before rendering}"

  sed \
    -e "s|@BUN_PATH@|$BUN_PATH|g" \
    -e "s|@BUNX_PATH@|$BUNX_PATH|g" \
    -e "s|@INSTALL_DIR@|$UNIT_INSTALL_DIR|g" \
    -e "s|@STATE_DIR@|$UNIT_STATE_DIR|g" \
    "$REPO_ROOT/scripts/engined.service.in" >"$out"

  assert_unit_names_no_user "$out"
}

main() {
  resolve_paths

  for tool in bun bunx rsync; do
    command -v "$tool" >/dev/null || {
      echo "install.sh: $tool not found on PATH" >&2
      exit 1
    }
  done
  BUN_PATH="$(command -v bun)"
  BUNX_PATH="$(command -v bunx)"

  COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"

  BUILD_DIR="$(mktemp -d)"
  trap 'rm -rf "$BUILD_DIR"' EXIT

  # The install dir is deliberately not a git tree, so GET /v1/engines can
  # only report the revision it was built from if it's baked in now.
  # ENGINED_COMMIT is a bare global; unset (no --define) it falls through to
  # "unknown" at the call site rather than throwing.
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
  render_unit_file "$UNIT_PATH"

  systemctl --user daemon-reload
  systemctl --user restart engined.service
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main
fi
