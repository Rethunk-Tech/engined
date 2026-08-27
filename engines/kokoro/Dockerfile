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

# uv owns the interpreter, not the distro: see engines/chatterbox/Dockerfile
# for why the base image's system python3 (Ubuntu 24.04's 3.12) is not a
# deliberate floor. Fleet floor is >=3.12, fleet standard is 3.14. Minor-only
# so uv resolves the newest 3.14.x patch rather than freezing one that goes
# stale.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
RUN uv python install 3.14
RUN uv venv --seed --python 3.14 /opt/venv
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
