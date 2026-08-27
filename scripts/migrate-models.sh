#!/usr/bin/env bash
# Moves ~/llm-models and ~/comfy-models under the models root engined owns,
# leaving a symlink at each old path so every running consumer -- sagaforge's
# env.ts, whatever starts Comfy today -- keeps resolving them unchanged.
# Nothing here deletes: it moves and it links. Re-running after a full or
# partial migration is safe and reports what is already done.
set -euo pipefail

: "${HOME:?HOME must be set}"

# Same resolution as src/paths.ts and scripts/install.sh: the env var when
# set and non-empty, else the fallback under $HOME.
xdg() {
  local var="$1" fallback="$2"
  local val="${!var:-}"
  if [[ -n "$val" ]]; then
    printf '%s\n' "$val"
  else
    printf '%s\n' "$HOME/$fallback"
  fi
}

ALLOW_CROSS_DEVICE=0
for arg in "$@"; do
  if [[ "$arg" == "--allow-cross-device" ]]; then
    ALLOW_CROSS_DEVICE=1
  fi
done

DATA_HOME="$(xdg XDG_DATA_HOME .local/share)"
if [[ -z "$DATA_HOME" || "$DATA_HOME" == "/" ]]; then
  echo "migrate-models.sh: resolved data home is empty or filesystem root, refusing" >&2
  exit 1
fi
MODELS_ROOT="$DATA_HOME/engined-models"

device_of() {
  stat -c '%d' "$1"
}

count_and_size() {
  local dir="$1" count size
  count="$(find "$dir" -type f | wc -l)"
  size="$(du -sb "$dir" | cut -f1)"
  printf '%s %s\n' "$count" "$size"
}

# Handles one old-path -> models-root/<subdir> pair end to end: already
# migrated, conflicting, missing, or ready to move.
migrate_one() {
  local old="$1" subdir="$2"
  local new="$MODELS_ROOT/$subdir"

  if [[ -L "$old" ]]; then
    local resolved_old resolved_new
    resolved_old="$(readlink -f "$old")"
    resolved_new="$(readlink -f "$new" 2>/dev/null || true)"
    if [[ -n "$resolved_new" && "$resolved_old" == "$resolved_new" && -d "$new" ]]; then
      echo "migrate-models.sh: $old already migrated to $new -- nothing to do"
      return 0
    fi
    echo "migrate-models.sh: $old is a symlink but does not point at $new, refusing" >&2
    exit 1
  fi

  if [[ -e "$new" ]]; then
    if [[ -n "$(ls -A "$new" 2>/dev/null)" ]]; then
      echo "migrate-models.sh: $new already exists and is non-empty, refusing" >&2
      exit 1
    fi
    # mv nests $old inside an existing $new instead of renaming onto it; an
    # empty directory is provably safe to clear with rmdir, which -- unlike
    # rm -rf -- fails on its own if anything has raced in and made it non-empty.
    rmdir "$new"
  fi

  if [[ ! -d "$old" ]]; then
    echo "migrate-models.sh: $old does not exist, nothing to migrate" >&2
    exit 1
  fi

  mkdir -p "$MODELS_ROOT"
  local src_device root_device
  src_device="$(device_of "$old")"
  root_device="$(device_of "$MODELS_ROOT")"
  if [[ "$src_device" == "$root_device" ]]; then
    echo "migrate-models.sh: $old and $MODELS_ROOT share a filesystem (device $src_device) -- mv is a rename"
  else
    echo "migrate-models.sh: $old (device $src_device) and $MODELS_ROOT (device $root_device) are on different filesystems -- this is a full copy, not a rename"
    if [[ "$ALLOW_CROSS_DEVICE" -ne 1 ]]; then
      echo "migrate-models.sh: refusing without --allow-cross-device" >&2
      exit 1
    fi
  fi

  local before
  before="$(count_and_size "$old")"

  mv "$old" "$new"
  ln -s "$new" "$old"

  if [[ ! -L "$old" || "$(readlink -f "$old")" != "$(readlink -f "$new")" ]]; then
    echo "migrate-models.sh: symlink at $old does not resolve to $new, refusing to call this done" >&2
    exit 1
  fi

  local after
  after="$(count_and_size "$new")"
  if [[ "$before" != "$after" ]]; then
    echo "migrate-models.sh: verification failed for $old -> $new: before='$before' after='$after'" >&2
    exit 1
  fi

  echo "migrate-models.sh: moved $old -> $new, verified $(echo "$after" | cut -d' ' -f1) files / $(echo "$after" | cut -d' ' -f2) bytes"
}

main() {
  migrate_one "$HOME/llm-models" "llm"
  migrate_one "$HOME/comfy-models" "comfy"
}

main
