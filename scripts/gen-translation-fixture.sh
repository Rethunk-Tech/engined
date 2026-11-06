#!/usr/bin/env bash
# Regenerates src/probeTranslation.es.wav: the Spanish clip the translation
# probe sends. Needs espeak-ng and ffmpeg. The sentence must stay in step with
# TRANSLATION_REFERENCE in src/probeTranslation.ts.
set -euo pipefail
out="$(cd "$(dirname "$0")/.." && pwd)/src/probeTranslation.es.wav"
tmp="$(mktemp --suffix=.wav)"
trap 'rm -f "$tmp"' EXIT
espeak-ng -v es -s 165 -w "$tmp" "El gato negro duerme en la mesa de madera"
ffmpeg -loglevel error -y -i "$tmp" -ac 1 -ar 16000 -c:a pcm_s16le "$out"
