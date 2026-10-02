# Piper TTS, CPU only. Ported from a Discord bot's
# internal/voicebootstrap, which downloaded a prebuilt piper tarball and
# cmake-built nothing but shipped its own shared libraries -- the work this
# engine removes from that repo.
#
# The one engine here with no GPU flags at all, and deliberately so. Piper is
# an ONNX model small enough that onnxruntime's CPU provider answers a
# sentence in well under a second, and this box has exactly one GPU: a TTS
# voice that never contends with a resident 25 GB GGUF is worth more than a
# faster one that does. No /dev/kfd, no /dev/dri, no group_add.
#
# Two-stage for the same reason chatterbox/kokoro/comfy are: build tools
# never reach the runtime image. There is nothing to compile -- piper-tts
# 1.7.0's only runtime dependencies are onnxruntime and pathvalidate, both
# pure wheels, and the espeak-ng phonemizer data ships inside the wheel
# itself (piper/espeak-ng-data/), so unlike kokoro this image installs no
# apt espeak-ng at all. What the split actually buys is dropping uv and curl.
FROM python:3.14.8-slim@sha256:89fb7d3da20043c370643435258bdd7ab755d326d359001d02988ed15ae5219e AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# The system interpreter, not a uv-managed one -- same trap kokoro's
# Dockerfile records: `uv python install` puts the interpreter outside
# /opt/venv, so a runtime stage copying only /opt/venv inherits a venv whose
# python symlink dangles. Nothing fails at build time; every container dies
# instantly on `exec /opt/venv/bin/uvicorn: no such file or directory`. The
# unversioned `python3` is what makes both stages agree: they share one FROM
# tag, so naming a minor version here turns the next base bump into a build
# that fails on a path that no longer exists.
COPY --from=ghcr.io/astral-sh/uv:0.12.19@sha256:04d046b13e60d6bcec73cbc5e1cad25d680dea90c8573340950a0ac2d1aef424 /uv /uvx /usr/local/bin/
RUN uv venv --seed --python /usr/local/bin/python3 /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# Pinned rather than floating: this image is rebuilt rarely and a voice that
# changes character between builds is exactly the kind of drift nobody
# attributes to a dependency bump.
RUN pip install --no-cache-dir \
      piper-tts==1.7.0 \
      onnx==1.20.1 \
      fastapi==0.141.1 \
      "uvicorn[standard]==0.52.4"

# Baked at build time, matching chatterbox's and kokoro's no-runtime-download
# posture: without this the first real request burns the adapter's timeout on
# a cold 63 MB download and looks like a hung engine.
#
# The exact pair a Discord bot image fetched
# (internal/voicebootstrap/manifest.go), so the operator hears the same voice
# after the move rather than a differently-tuned one that "sounds a bit off"
# with nothing to point at.
ARG PIPER_VOICE=en_US-lessac-medium
ARG PIPER_VOICE_REV=c10ece1aade47bb51c153c893d14e5bf8e5b7117
ARG PIPER_VOICE_BASE=https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICE_REV}/en/en_US/lessac/medium
RUN mkdir -p /app/voices \
    && curl -fsSL -o "/app/voices/${PIPER_VOICE}.onnx" "${PIPER_VOICE_BASE}/${PIPER_VOICE}.onnx" \
    && curl -fsSL -o "/app/voices/${PIPER_VOICE}.onnx.json" "${PIPER_VOICE_BASE}/${PIPER_VOICE}.onnx.json" \
    && echo "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f  /app/voices/${PIPER_VOICE}.onnx" | sha256sum -c \
    && echo "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0  /app/voices/${PIPER_VOICE}.onnx.json" | sha256sum -c \
    # Published voices export audio only. Marking the model's phoneme-duration
    # tensor as a second output is what lets synthesize() report per-phoneme
    # sample counts, which /v1/tts turns into word timings. onnx is here for this
    # one step; the runtime never imports it.
    && python3 -m piper.patch_voice_with_alignment "/app/voices/${PIPER_VOICE}.onnx"

FROM python:3.14.8-slim@sha256:89fb7d3da20043c370643435258bdd7ab755d326d359001d02988ed15ae5219e

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PATH="/opt/venv/bin:${PATH}"
ENV PIPER_VOICE_PATH=/app/voices/en_US-lessac-medium.onnx

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /app/voices /app/voices

WORKDIR /app
COPY app.py .

# One spelling of the port: docker.ts derives the container side from EXPOSE
# alone, so a second literal in the command below could drift from it and
# leave the door dialling a port nothing listens on.
ARG PORT=8006
ENV PORT=${PORT}
EXPOSE ${PORT}

# --log-level explicit for the same reason kokoro's is: uvicorn's default
# emits a per-request access line, and this engine is called once per spoken
# reply in a voice channel.
#
# `exec` so uvicorn, not the shell, is PID 1 and takes the stop signal itself.
# Exec-form CMD would leave $PORT unexpanded.
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port $PORT --log-level warning"]
