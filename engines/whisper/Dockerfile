# Thin wrapper, not a rebuild: the pinned upstream layer is untouched, this
# only adds the one thing docker.ts's port discovery needs and the upstream
# image never declares. `docker image inspect` on the pinned digest shows
# `Config.ExposedPorts: null` and no EXPOSE in its build history -- confirmed
# live, not assumed -- so engined's checkImage() (one exposed port is the
# only way it learns the container-side port) refuses to even attempt
# `docker run` against the bare upstream image. 8080 is whisper-server's own
# documented default (`whisper-server --help`), matching the command's own
# `--host 0.0.0.0` with no `--port` override below.
#
# main-vulkan, not main: `docker manifest inspect` against
# ghcr.io/ggml-org/whisper.cpp confirms main-vulkan is a real, published,
# multi-arch tag -- upstream's own .devops/main-vulkan.Dockerfile builds it
# from ubuntu:24.04 with `-DGGML_VULKAN=1` and ships `mesa-vulkan-drivers` in
# the runtime layer, so RADV comes bundled rather than depending on the
# host's userspace driver. No from-source build needed here: same flags
# engines/llama's Dockerfile builds from source, already built and signed
# upstream. Confirmed live on this box, GPU passed through: startup log
# reads "ggml_vulkan: Found 1 Vulkan devices: 0 = Radeon 8060S Graphics
# (RADV GFX1151) (radv)" and "whisper_backend_init_gpu: using Vulkan0
# backend" -- genuinely offloaded, not a driver that loaded and silently
# fell back to CPU. Faster than the CPU image at every probed
# clip length/model pair (docs/engines.md). Same CLI surface
# too: `whisper-server --help` on this image lists every flag the command
# below already passes (--vad, -vm, --request-path, --inference-path, -fa,
# -t, --no-timestamps) -- this is a backend swap, not a flag migration.
FROM ghcr.io/ggml-org/whisper.cpp@sha256:0f4647714291485fc6f9f264785749b46ba4bc3d28637728fca365411fb02b81
# ENV as well as EXPOSE, because the two readers of this port arrive by
# different routes: docker.ts reads EXPOSE off the built image, while
# whisper_app.py is bind-mounted through {spec_dir} and never rebuilt, so a
# baked-in literal there could drift from this one on nothing more than a
# container restart. The environment is the only channel that reaches both.
ARG PORT=8080
ENV PORT=${PORT}
EXPOSE ${PORT}
