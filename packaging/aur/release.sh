#!/usr/bin/env bash
# Release engined and publish it to the AUR from this machine.
#
#   release.sh tag <version>      date the changelog, bump, commit, tag (local)
#   release.sh publish <version>  push main and the tag, wait for the release
#                                 workflow, point `engined` at the tarball it
#                                 attached, publish `engined` to the AUR
#
# The bundle is architecture-independent, so there is no -bin package. The
# `engined` package installs the tarball the release workflow builds, so its
# checksum is that asset's, known only once the workflow has run: it is a commit
# on top of the tag, made by `publish` and pushed with the next push to main.
#
# The AUR account is shared with packages that are not ours, so the AUR push
# names its package base and never iterates over the account's repos.
set -euo pipefail

cmd=${1:-}
version=${2:-}
version=${version#v}
[[ $cmd =~ ^(tag|publish)$ && $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "usage: ${0##*/} tag|publish <version>" >&2
  exit 2
}
tag="v$version"
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
aur="$root/packaging/aur"
cd "$root"

die() { echo "${0##*/}: $*" >&2; exit 1; }

# A sum that did not arrive as 64 hex characters is an error page or a
# truncated read, and writing it into a PKGBUILD hides that until a user builds.
hex64() {
  [[ $1 =~ ^[0-9a-f]{64}$ ]] || die "not a sha256: $1"
  printf '%s\n' "$1"
}

# makepkg is Arch-only. The package directory is copied in rather than mounted
# writable, so nothing in the tree ends up owned by the container's user.
in_arch() {
  local pkg=$1 script=$2
  docker run --rm -i -v "$root:/repo:ro" archlinux:base-devel bash -c '
    set -e
    pacman -Sy --noconfirm --needed --quiet git >/dev/null 2>&1
    useradd -m b
    git config --system --add safe.directory "*"
    cp -r "/repo/packaging/aur/$1" /tmp/p
    chown -R b /tmp/p
    cd /tmp/p
    su b -c "$2"
  ' _ "$pkg" "$script"
}

srcinfo() { in_arch "$1" 'makepkg --printsrcinfo' >"$aur/$1/.SRCINFO"; }

aur_push() {
  local pkg=$1 work
  work=$(mktemp -d)
  git clone -q "ssh://aur@aur.archlinux.org/$pkg.git" "$work/$pkg" 2>/dev/null
  cp "$aur/LICENSE" "$aur/$pkg/"{PKGBUILD,.SRCINFO,engined.install} "$work/$pkg/"
  git -C "$work/$pkg" add PKGBUILD .SRCINFO LICENSE engined.install
  if git -C "$work/$pkg" diff --cached --quiet; then
    echo "AUR $pkg already at $version"
  else
    git -C "$work/$pkg" commit -q -m "engined $version"
    # The AUR accepts pushes to master only.
    git -C "$work/$pkg" push -q origin HEAD:master
    echo "AUR $pkg pushed $version"
  fi
  rm -rf -- "$work"
}

# The changelog section for $version, without its heading: the tag annotation
# body, which the release workflow turns into the GitHub release notes.
notes() {
  awk -v h="## $version " 'index($0, h) == 1 { on = 1; next } on && /^## / { exit } on' CHANGELOG.md
}

tag_release() {
  [[ $(git rev-parse --abbrev-ref HEAD) == main ]] || die "not on main"
  git diff --quiet HEAD || die "uncommitted changes"
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "$tag already exists"
  grep -q '^## Unreleased$' CHANGELOG.md || die "CHANGELOG.md has no '## Unreleased' section"

  sed -i "s/^## Unreleased$/## $version - $(date -u +%F)/" CHANGELOG.md
  sed -i "0,/^  \"version\": .*/s//  \"version\": \"$version\",/" package.json
  git add CHANGELOG.md package.json
  git commit -q -m "chore(release): engined $version"
  { echo "engined $version"; echo; notes; } | git tag -a --cleanup=verbatim "$tag" -F -

  echo "tagged $tag; next: ${0##*/} publish $version"
}

# The release workflow run for the tag's commit: the run list can lag the push
# by a few seconds, so it is polled for rather than read once.
release_run() {
  local sha id
  sha=$(git rev-parse "$tag^{commit}")
  for _ in $(seq 1 30); do
    id=$(gh run list --workflow release.yml --json databaseId,headSha --limit 20 \
      --jq ".[] | select(.headSha == \"$sha\") | .databaseId" | head -n 1)
    [[ -n $id ]] && { printf '%s\n' "$id"; return; }
    sleep 4
  done
  die "no release workflow run for $tag ($sha)"
}

# Download the asset the workflow attached, write its checksum into the PKGBUILD.
point_at_asset() {
  local work sum
  work=$(mktemp -d)
  gh release download "$tag" --pattern "engined-$version.tar.gz" --dir "$work"
  sum=$(sha256sum "$work/engined-$version.tar.gz" | cut -d' ' -f1)
  rm -rf -- "$work"
  sed -i "s/^pkgver=.*/pkgver=$version/; s/^pkgrel=.*/pkgrel=1/" "$aur/engined/PKGBUILD"
  sed -i "s|^sha256sums=('[^']*')|sha256sums=('$(hex64 "$sum")')|" "$aur/engined/PKGBUILD"
  srcinfo engined
  git add "$aur/engined"
  if git diff --cached --quiet; then
    echo "packaging/aur/engined already at $version"
  else
    git commit -q -m "chore(aur): engined $version"
  fi
}

publish() {
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "no tag $tag; run: ${0##*/} tag $version"

  echo "pushing main and $tag:"
  git log --oneline '@{u}..HEAD'
  git push -q --atomic origin main "refs/tags/$tag"
  gh run watch "$(release_run)" --exit-status
  point_at_asset
  aur_push engined
}

case $cmd in
  tag) tag_release ;;
  publish) publish ;;
esac
