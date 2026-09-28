#!/usr/bin/env bash
# Builds and installs engined as a systemd --user unit. Running this again
# is the update: it re-bundles, re-syncs engines/, rewrites the unit, and
# restarts. There is no other install or update path.
set -euo pipefail

: "${HOME:?HOME must be set}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

# Where engined lives is src/paths.ts's answer, asked rather than restated: the
# daemon reads config and writes state at whatever that module returns, so a
# second implementation here can only ever be the one that is wrong. Only the
# systemd spelling below is install-side knowledge.
resolve_paths() {
  local resolved
  resolved="$(bun -e "
    import { configHome, installDir, stateDir } from '$REPO_ROOT/src/paths.ts';
    console.log([installDir(), stateDir(), configHome()].join('\n'));
  ")"
  { read -r INSTALL_DIR && read -r STATE_DIR && read -r CONFIG_HOME; } <<<"$resolved"

  # rsync --delete runs inside INSTALL_DIR and the unit file lands under
  # CONFIG_HOME, so neither may sit at the top of the filesystem -- which is
  # where an empty XDG var resolves to. Two segments deep is the shallowest any
  # of these can legitimately be.
  local dir
  for dir in "$INSTALL_DIR" "$STATE_DIR" "$CONFIG_HOME"; do
    if [[ "$dir" != /?*/?* ]]; then
      echo "install.sh: src/paths.ts resolved \"$dir\", too shallow to install into" >&2
      exit 1
    fi
  done

  UNIT_DIR="$CONFIG_HOME/systemd/user"
  UNIT_PATH="$UNIT_DIR/engined.service"
  PROBE_SERVICE_PATH="$UNIT_DIR/engined-probe.service"
  PROBE_TIMER_PATH="$UNIT_DIR/engined-probe.timer"
  TLS_SERVICE_PATH="$UNIT_DIR/engined-tls.service"

  # The terminator runs the same way every engine does -- a container this
  # box already knows how to pull -- so it adds no host package.
  DOCKER_PATH="$(command -v docker || true)"
  CADDY_IMAGE="caddy:2.11.4-alpine"

  UNIT_INSTALL_DIR="$(to_unit_path "$INSTALL_DIR")"
  UNIT_STATE_DIR="$(to_unit_path "$STATE_DIR")"
}

# True when $1 names $2 as a whole path segment. Unanchored substring match
# would refuse any username that appears inside another component (ed in
# engined, ted in stated, …) and those users could never install.
path_has_segment() {
  local p="$1" seg="$2"
  [[ "$p" == "$seg" || "$p" == "$seg/"* || "$p" == *"/$seg" || "$p" == *"/$seg/"* ]]
}

# The %h rewrite in to_unit_path is the whole guarantee that no path in the
# generated unit names a user; this is what catches a future template edit that
# bypasses it before the file ever lands on disk. It covers the resolved bun
# binaries too: bun installs under $HOME by default, and systemd expands %h in
# ExecStart's program position exactly as it does in ReadWritePaths.
assert_unit_names_no_user() {
  local out="$1" user exec_line daemon_path user_ere
  user="$(id -un)"

  if [[ "$UNIT_INSTALL_DIR" == "$HOME"* ]] || path_has_segment "$UNIT_INSTALL_DIR" "$user" ||
    [[ "$UNIT_STATE_DIR" == "$HOME"* ]] || path_has_segment "$UNIT_STATE_DIR" "$user"; then
    echo "install.sh: install/state dir still names \$HOME or the user, refusing to render" >&2
    exit 1
  fi

  # A timer unit has no ExecStart at all, and grep exiting 1 under `set -e`
  # would take the install down before the whole-file check below ever ran.
  exec_line="$(grep '^ExecStart=' "$out" || true)"
  if [[ -n "$exec_line" ]]; then
    daemon_path="${exec_line#*ExecStart=* }"
    if [[ "$daemon_path" == "$HOME"* ]] || path_has_segment "$daemon_path" "$user"; then
      echo "install.sh: ExecStart's daemon path names \$HOME or the user, refusing" >&2
      exit 1
    fi
  fi

  # $HOME is a literal path, never an ERE. The username is a path segment so
  # it cannot fire on a longer name that merely contains it.
  user_ere="$(printf '%s' "$user" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"
  if grep -qF -- "$HOME" "$out" || grep -qE -- "(^|/)${user_ere}(/|$)" "$out"; then
    echo "install.sh: the rendered unit names \$HOME or the user, refusing" >&2
    exit 1
  fi
}

# Every generated unit goes through here, so the %h rewrite and the no-user
# assertion below cover the probe timer exactly as they cover the daemon.
render_unit_file() {
  local template="$1" out="$2"
  : "${BUN_PATH:?BUN_PATH must be resolved before rendering}"
  : "${BUNX_PATH:?BUNX_PATH must be resolved before rendering}"

  sed \
    -e "s|@BUN_PATH@|$(to_unit_path "$BUN_PATH")|g" \
    -e "s|@BUNX_PATH@|$(to_unit_path "$BUNX_PATH")|g" \
    -e "s|@DOCKER_PATH@|$(to_unit_path "$DOCKER_PATH")|g" \
    -e "s|@CADDY_IMAGE@|$CADDY_IMAGE|g" \
    -e "s|@INSTALL_DIR@|$UNIT_INSTALL_DIR|g" \
    -e "s|@STATE_DIR@|$UNIT_STATE_DIR|g" \
    "$REPO_ROOT/scripts/$template" >"$out"

  assert_unit_names_no_user "$out"
}

main() {
  for tool in bun bunx rsync; do
    command -v "$tool" >/dev/null || {
      echo "install.sh: $tool not found on PATH" >&2
      exit 1
    }
  done

  resolve_paths

  BUN_PATH="$(command -v bun)"
  BUNX_PATH="$(command -v bunx)"

  COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"

  # The install dir is deliberately not a git tree, so GET /engined/v1/engines can
  # only report the revision it was built from if it's baked in now. The bundle
  # is `bun run build`'s -- one definition of the flags -- and ENGINED_COMMIT is
  # declared as the turbo task's env input, which is what stops the cache handing
  # back a bundle stamped with a different commit.
  #
  # The bundle has no runtime dependencies, so a checkout with nothing installed
  # builds the same bytes. turbo and tsc are devDependencies: where they are
  # present the turbo run adds a typecheck and replays a re-install at the same
  # commit from cache, and where they are not, going straight to the build is what
  # keeps this working on a cold clone with no network -- rather than an install
  # step whose lockfile check can fail an update for a reason unrelated to it.
  (
    cd "$REPO_ROOT"
    export ENGINED_COMMIT="$COMMIT"
    if [[ -x node_modules/.bin/turbo ]]; then
      bunx turbo run build
    else
      bun run build
    fi
  )

  mkdir -p "$INSTALL_DIR" "$STATE_DIR" "$STATE_DIR/bun-install" "$STATE_DIR/tmp" "$CONFIG_HOME/engined"

  # main.js is one file, fully overwritten every run; engines/ syncs with
  # --delete because a spec directory removed from the repo has to disappear
  # from the install too, or the engine it backed stays configured against a
  # stale copy instead of reporting unavailable.
  #
  # This --delete is why the model tree is a SIBLING of the install directory
  # ($DATA_HOME/engined-models, not $INSTALL_DIR/models) and must stay one.
  # Nothing under here survives a sync it is not part of, and the model tree
  # is ~90 GB that no download step would replace.
  cp "$REPO_ROOT/dist/main.js" "$INSTALL_DIR/main.js"
  rsync -a --delete "$REPO_ROOT/engines/" "$INSTALL_DIR/engines/"

  mkdir -p "$UNIT_DIR"
  render_unit_file engined.service.in "$UNIT_PATH"
  # The vision probe is the only thing that re-proves the one acceptance
  # criterion docs/engines.md records as unproven, and a wrong description is
  # invisible in the response, so these ship enabled rather than as something
  # to remember. A box with none of the probed routes configured gets a probe
  # that says so and exits 0 -- no red unit for a capability nobody asked for.
  render_unit_file engined-probe.service.in "$PROBE_SERVICE_PATH"
  render_unit_file engined-probe.timer.in "$PROBE_TIMER_PATH"

  # The Cursor door is unreachable without a TLS terminator: cursor-agent
  # picks HTTP/1.1 for its boot chain and HTTP/2 for the turn stream by ALPN,
  # which a cleartext listener cannot offer. Shipping the Caddyfile without
  # something that runs it would leave that door quietly broken.
  if [[ -n "$DOCKER_PATH" ]]; then
    cp "$REPO_ROOT/deploy/Caddyfile.cursor" "$INSTALL_DIR/Caddyfile.cursor"
    render_unit_file engined-tls.service.in "$TLS_SERVICE_PATH"
  fi

  # The probe covered vision alone when it was installed under that name. An
  # install that predates the rename still has its timer enabled, and rsync
  # --delete takes the unit file out from under it, so a box updating in place
  # would keep a timer whose ExecStart no longer resolves. Removed here rather
  # than left to fail weekly and silently.
  if [[ -e "$UNIT_DIR/engined-vision-probe.timer" ]]; then
    systemctl --user disable --now engined-vision-probe.timer || true
    rm -f "$UNIT_DIR/engined-vision-probe.timer" "$UNIT_DIR/engined-vision-probe.service"
  fi

  systemctl --user daemon-reload
  # enable, not just restart: without it the unit is only ever running because
  # someone ran this script, and a logout takes it down for good. Restarting
  # before config.toml exists exits 78, and RestartPreventExitStatus then
  # leaves the unit failed, so a fresh box is told the next step instead.
  systemctl --user enable engined.service
  if [[ -f "$CONFIG_HOME/engined/config.toml" ]]; then
    systemctl --user restart engined.service
  else
    echo "install.sh: no config.toml in $CONFIG_HOME/engined; copy config.example.toml there, then: systemctl --user restart engined.service" >&2
  fi
  systemctl --user enable --now engined-probe.timer
  if [[ -n "$DOCKER_PATH" ]]; then
    systemctl --user enable engined-tls.service
    systemctl --user restart engined-tls.service
  else
    echo "install.sh: docker not found; engined-tls left disabled (Cursor door needs it)" >&2
  fi
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main
fi
