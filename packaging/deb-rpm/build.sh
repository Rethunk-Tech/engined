#!/usr/bin/env bash
# Builds engined_<version>_<arch>.deb and engined-<version>-1.<arch>.rpm for one architecture.
# Usage: packaging/deb-rpm/build.sh <x64|arm64> <outdir>
# Needs bun, curl, sha256sum. nfpm is downloaded (pinned) into a scratch directory, never onto PATH.
set -euo pipefail

NFPM_VERSION=2.48.0
NFPM_SHA256_x64=6d7f9a28b2f397934403950fcbba83f598b08d02edbe79a0815b3b4897341750
NFPM_SHA256_arm64=a9a75213763783b7669719e505474c748c5ad7dc66591a195619deb50f85c2f4

arch="${1:?usage: build.sh <x64|arm64> <outdir>}"
out="$(mkdir -p "${2:?usage: build.sh <x64|arm64> <outdir>}" && cd "$2" && pwd)"
case "$arch" in
  x64) export ARCH=amd64 ;;
  arm64) export ARCH=arm64 ;;
  *) echo "build.sh: arch must be x64 or arm64" >&2; exit 2 ;;
esac
# nfpm runs on this machine, whatever architecture it packages for.
case "$(uname -m)" in
  x86_64) nfpm_os_arch=x86_64 sha="$NFPM_SHA256_x64" ;;
  aarch64 | arm64) nfpm_os_arch=arm64 sha="$NFPM_SHA256_arm64" ;;
  *) echo "build.sh: no pinned nfpm for $(uname -m)" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT"
VERSION="$(bun -e 'console.log(require("./package.json").version)')"
export VERSION

work="$(mktemp -d "${TMPDIR:-/var/tmp}/engined-pkg.XXXXXX")"
trap 'rm -rf "$work"' EXIT
STAGE="$work/stage"
export STAGE

tarball="nfpm_${NFPM_VERSION}_Linux_${nfpm_os_arch}.tar.gz"
curl -fsSL -o "$work/$tarball" "https://github.com/goreleaser/nfpm/releases/download/v${NFPM_VERSION}/$tarball"
echo "$sha  $work/$tarball" | sha256sum -c --quiet
tar -xzf "$work/$tarball" -C "$work" nfpm

# bun --compile embeds the config UI's page and hashed assets, so the one file is the whole program.
bun build src/main.ts --compile --target="bun-linux-$arch" \
  --define "ENGINED_COMMIT=\"${ENGINED_COMMIT:-unknown}\"" --outfile "$work/engined"

install -Dm0755 "$work/engined" "$STAGE/usr/bin/engined"
# A compiled bun binary acts as bun when BUN_BE_BUN=1, so `x` is bunx.
install -Dm0755 /dev/stdin "$STAGE/usr/lib/engined/bunx" <<'WRAPPER'
#!/bin/sh
BUN_BE_BUN=1 exec /usr/bin/engined x "$@"
WRAPPER
install -Dm0644 deploy/Caddyfile.cursor "$STAGE/usr/lib/engined/Caddyfile.cursor"
cp -r --no-preserve=ownership engines "$STAGE/usr/lib/engined/engines"
find "$STAGE/usr/lib/engined/engines" -name __pycache__ -prune -exec rm -rf {} +

# install.sh's own renderer, so the units cannot drift from the templates. The binary is its own
# entry point, so the "<bun> main.js" pair collapses to the binary.
(
  # shellcheck source=/dev/null
  source scripts/install.sh
  resolve_paths
  export BUN_PATH=/usr/bin/engined BUNX_PATH=/usr/lib/engined/bunx DOCKER_PATH=/usr/bin/docker
  export UNIT_INSTALL_DIR=/usr/lib/engined UNIT_STATE_DIR=%S/engined UNIT_CONFIG_DIR=%h/.config/engined
  install -d "$STAGE/usr/lib/systemd/user"
  for unit in engined.service engined-configsvc.service engined-probe.service engined-probe.timer engined-tls.service; do
    render_unit_file "$unit.in" "$STAGE/usr/lib/systemd/user/$unit"
  done
)
sed -i \
  -e 's|^ConditionPathExists=/usr/lib/engined/main\.js|ConditionPathExists=/usr/bin/engined|' \
  -e 's|^\(Exec[A-Za-z]*=/usr/bin/engined\) /usr/lib/engined/main\.js|\1|' \
  "$STAGE"/usr/lib/systemd/user/*
if grep -l 'main\.js' "$STAGE"/usr/lib/systemd/user/*; then
  echo "build.sh: a rendered unit still names main.js" >&2
  exit 1
fi

install -Dm0644 config.example.toml "$STAGE/usr/share/engined/config.example.toml"
install -Dm0644 config.schema.json "$STAGE/usr/share/engined/config.schema.json"
install -Dm0644 HUMANS.md "$STAGE/usr/share/doc/engined/HUMANS.md"
cp -r --no-preserve=ownership docs/. "$STAGE/usr/share/doc/engined/"
install -Dm0644 LICENSE "$STAGE/usr/share/doc/engined/copyright"
install -Dm0644 THIRD_PARTY_NOTICES.md "$STAGE/usr/share/doc/engined/THIRD_PARTY_NOTICES.md"

sed -e "s|\${STAGE}|$STAGE|g" -e "s|\${HERE}|$HERE|g" "$HERE/nfpm.yaml" >"$work/nfpm.yaml"
for fmt in deb rpm; do
  "$work/nfpm" package --config "$work/nfpm.yaml" --packager "$fmt" --target "$out/"
done
ls -l "$out"
