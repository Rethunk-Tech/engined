#!/bin/sh
# fetch.sh DEST SHA256 URL: downloads beside DEST, checks the digest, then renames,
# so DEST exists only when it is complete and matches the pinned bytes.
set -eu
dest=$1 sha=$2 url=$3
part="$dest.part"
trap 'rm -f -- "$part"' EXIT
curl -fL -o "$part" -- "$url"
echo "$sha  $part" | sha256sum -c - || { echo "sha256 mismatch for $url" >&2; exit 1; }
mv -- "$part" "$dest"
