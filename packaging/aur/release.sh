#!/usr/bin/env bash
# Release engined and publish it to the AUR from this machine.
#
#   release.sh tag <version>      date the changelog, bump, commit, tag, and
#                                 point `engined` at the tag
#   release.sh publish <version>  push main and the tag, publish `engined`
#
# The bundle is architecture-independent, so there is no -bin package and
# nothing here waits on CI.
#
# The `engined` checksum cannot live in the tagged commit: makepkg checksums a
# git source over the tagged tree, and the PKGBUILD is part of that tree. So the
# sum is a commit on top of the tag. It is taken from the local tag, which gives
# the same sum as a GitHub clone.
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
  { echo "engined $version"; echo; notes; } | git tag -a "$tag" -F -

  sed -i "s/^pkgver=.*/pkgver=$version/; s/^pkgrel=.*/pkgrel=1/" "$aur/engined/PKGBUILD"
  # A later source= wins, so the sum comes from the local tag, before it is pushed.
  local sum
  sum=$(in_arch engined "echo 'source=(\"engined::git+file:///repo#tag=$tag\")' >>PKGBUILD && makepkg -g" |
    sed -n "s/^sha256sums=('\([^']*\)')$/\1/p")
  sed -i "s|^sha256sums=('[^']*')|sha256sums=('$(hex64 "$sum")')|" "$aur/engined/PKGBUILD"
  srcinfo engined
  git add "$aur/engined"
  git commit -q -m "chore(aur): engined $version"
  echo "tagged $tag; next: ${0##*/} publish $version"
}

publish() {
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "no tag $tag; run: ${0##*/} tag $version"
  grep -q "^pkgver=$version$" "$aur/engined/PKGBUILD" || die "packaging/aur/engined is not at $version"

  echo "pushing main and $tag:"
  git log --oneline '@{u}..HEAD'
  git push -q --atomic origin main "refs/tags/$tag"
  aur_push engined
}

case $cmd in
  tag) tag_release ;;
  publish) publish ;;
esac
