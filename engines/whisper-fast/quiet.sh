#!/bin/bash
# whisper-server has no --quiet and no log-level flag, so it prints the same
# five lines on every single request. This is a log filter, not a security
# or log-level control: it drops exactly those lines and passes everything
# else -- startup banner, real errors -- straight through.
#
# `exec` replaces this shell with whisper-server itself, so the server
# becomes the container's real PID 1: docker sees its actual exit status and
# its signals directly, rather than a wrapper shell's. Redirecting its
# stdout through process substitution (not a `cmd | awk` pipe) keeps that
# true -- a pipe would make the shell wait on both stages and the container
# would report the last stage's exit status, not the server's.
set -euo pipefail

exec /app/build/bin/whisper-server "$@" > >(awk '
  !/Received request:|Successfully loaded|Running whisper\.cpp inference|system_info:|operator\(\): processing/ {
    print
    fflush()
  }
')
