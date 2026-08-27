# Thin wrapper, not a rebuild: the pinned upstream layer is untouched, this
# only adds the one thing docker.ts's port discovery needs and the upstream
# image never declares. `docker image inspect` on the pinned digest shows
# `Config.ExposedPorts: null` and no EXPOSE in its build history -- confirmed
# live, not assumed -- so engined's checkImage() (one exposed port is the
# only way it learns the container-side port) refuses to even attempt
# `docker run` against the bare upstream image. 8080 is whisper-server's own
# documented default (`whisper-server --help`), matching the command's own
# `--host 0.0.0.0` with no `--port` override below.
FROM ghcr.io/ggml-org/whisper.cpp@sha256:793c6caae47b63c4f76d7a533e368c31cc32c2fe341feee103e76f5f7d12e889
EXPOSE 8080
