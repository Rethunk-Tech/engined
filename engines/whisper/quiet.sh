#!/bin/bash
# whisper-server has no --quiet and no log-level flag, so it prints the same
# five lines on every single request. This is a log filter, not a security
# or log-level control: it drops exactly those lines and passes everything
# else -- startup banner, real errors -- straight through.
#
# `exec` replaces this shell with whisper_app.py, so that becomes the
# container's real PID 1: docker sees its actual exit status and its signals
# directly, rather than a wrapper shell's. whisper-server runs as its child on
# loopback and inherits this same stdout, so the filter covers both.
# Redirecting through process substitution (not a `cmd | awk` pipe) keeps the
# exit status true -- a pipe would make the shell wait on both stages and the
# container would report the last stage's exit status, not the app's.
#
# `-u` because a python holding its own log lines in a buffer would defeat the
# filter's whole purpose of showing what is happening as it happens.
set -euo pipefail

exec python3 -u /spec/whisper_app.py "$@" > >(awk '
  !/Received request:|Successfully loaded|Running whisper\.cpp inference|system_info:|operator\(\): processing/ {
    print
    fflush()
  }
')
