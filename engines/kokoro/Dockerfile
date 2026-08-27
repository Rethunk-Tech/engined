# Kokoro-82M TTS, ROCm variant (gfx1151 / Strix Halo), self-built. Ported
# from sagaforge-ts's docker/kokoro/Dockerfile.rocm (read from source, not a
# summary) rather than pulling majordomo's vendored ghcr.io/remsky
# kokoro-fastapi image: that image speaks OpenAI's /v1/audio/speech
# natively, and engined's audio door already translates the native NDJSON
# /v1/tts contract this build speaks (src/audio.ts) -- taking the vendor
# image would need a second, non-translating code path through a door meant
# to have exactly one. app.py is vendored verbatim from that same directory,
# the same wrapper docker/chatterbox/app.py implements the contract for.
#
# Two-stage, same discipline as chatterbox/comfy: build tools never reach
# the runtime image. Same base as both -- rocm/dev-ubuntu-24.04:7.2.4, not
# rocm/pytorch -- the official PyTorch ROCm wheel is self-contained. Native
# gfx1151 detection, no HSA_OVERRIDE_GFX_VERSION.
FROM rocm/dev-ubuntu-24.04:7.2.4 AS builder

# espeak-ng here too (not just the runtime stage): misaki's G2P backend can
# shell out to it during KPipeline init, and the weight-baking step below
# needs that to succeed at build time.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential git ca-certificates espeak-ng \
    && rm -rf /var/lib/apt/lists/*

# kokoro caps itself below 3.13: every release from 0.8.1 through 0.9.4
# declares Requires-Python >=3.10,<3.13, and upstream HEAD is still <3.14, so
# no published release installs on the fleet's 3.14 at all. 3.12 is the only
# version satisfying both that ceiling and the fleet's >=3.12 floor -- and it
# is exactly what this base image already ships, in both stages.
#
# That is why the venv is built on the system interpreter rather than a
# uv-managed one. `uv python install` puts the interpreter under
# /root/.local/share/uv/, outside /opt/venv, so a runtime stage that copies
# only /opt/venv inherits a venv whose python symlink dangles. Nothing fails
# at build time: the image exports clean and every container dies instantly
# on `exec /opt/venv/bin/uvicorn: no such file or directory`, an error that
# names the script rather than the interpreter its shebang cannot reach.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
RUN uv venv --seed --python /usr/bin/python3.12 /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# torch only -- no torchvision/torchaudio, kokoro doesn't need them.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/rocm7.2

# Pinned here rather than via an unversioned requirements.txt (the source
# ships one with no version on any of these four, and no CI to catch
# drift) -- confirmed current on PyPI at the time these were pinned.
RUN pip install --no-cache-dir \
      kokoro==0.9.4 \
      soundfile==0.14.0 \
      fastapi==0.141.1 \
      "uvicorn[standard]==0.52.4"

# Bakes the HuggingFace download into the image at build time -- matches
# Chatterbox's no-runtime-download posture. Without this, the first real
# request burns the adapter's timeout on a cold download and looks like a
# hung engine.
ENV HF_HOME=/app/hf_cache
RUN python3 -c "from kokoro import KPipeline; KPipeline(lang_code='a')"

FROM rocm/dev-ubuntu-24.04:7.2.4

# espeak-ng is a runtime dependency of misaki's G2P (out-of-dictionary
# fallback), not just a build-time one -- a build that only installs it in
# the builder stage produces an image that pronounces common words fine and
# mangles rare ones, silently, with no error anywhere. libsndfile1 backs
# soundfile's WAV encode. rocrand-dev is a runtime dependency too despite the
# "-dev" name: the minimal rocm/dev-ubuntu-24.04 base doesn't ship it, and
# Kokoro's LSTM layer's dropout op needs MIOpen to JIT-compile a HIP kernel
# against <rocrand/rocrand_xorwow.h> the first time it runs -- without this
# package that compile fails with `MIOpen(HIP): Error [Compile] ...
# HIPRTC_ERROR_COMPILATION`, on every single request. Confirmed working with
# it present on this exact box (gfx1151, ROCm 7.2.4).
RUN apt-get update && apt-get install -y --no-install-recommends \
      espeak-ng libsndfile1 rocrand-dev \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/app/hf_cache
ENV PATH="/opt/venv/bin:${PATH}"
# Without this, MIOpen re-searches kernels on every new process -- 5-60s
# added latency per request on this exact ROCm/gfx1151 stack (Kokoro-FastAPI
# on Ryzen AI MAX+ 395 / Radeon 8060S, ROCm 7.2.0).
# https://github.com/remsky/Kokoro-FastAPI/issues/454
ENV MIOPEN_FIND_MODE=2

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /app/hf_cache /app/hf_cache

WORKDIR /app
COPY app.py .

EXPOSE 8005

# --log-level explicit rather than left to uvicorn's default: the vendor
# kokoro-fastapi image this build replaces hardcoded --log-level debug in
# its entrypoint.sh and flooded the log with a per-request access line;
# warning drops that same class of noise here before it becomes the
# identical problem under a different image.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8005", "--log-level", "warning"]
