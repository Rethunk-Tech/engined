# One recipe, two images: engines/chatterbox-en and engines/chatterbox-multi
# each build this file from their own spec dir as context, passing the
# checkpoint to bake and the port to serve as build args (declared in that
# spec dir's `build-args`, which src/docker.ts turns into `--build-arg`
# flags). They stay separate tags from separate builds by operator decision --
# one image failing to build never blocks the other's launch. This file and
# the model-agnostic half of the wrapper reach each build through the `shared`
# context named in that spec dir's `build-contexts`; app.py comes from the
# spec dir itself.
#
# Verified against sagaforge-ts's docker/chatterbox/Dockerfile (read-only
# fleet access, not a summary). Two-stage, same pattern as docker/comfyui:
# minimal rocm/dev-ubuntu-24.04 (not rocm/pytorch or "-complete" -- the
# official PyTorch ROCm wheel already bundles MIOpen/rocBLAS/etc., so a base
# that also ships those just duplicates them). Build tools never reach the
# runtime image. The wrapper is sagaforge's own FastAPI app speaking the
# NDJSON /v1/tts contract src/audio.ts translates -- the upstream devnen repo
# has no compatible HTTP surface of its own.
FROM rocm/dev-ubuntu-24.04:7.2.4 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Fleet standard is developing and running on 3.14, and chatterbox carries
# no Requires-Python ceiling forcing a lower one -- but `uv python install`
# puts the interpreter under /root/.local/share/uv/, outside /opt/venv, and
# the runtime stage below copies only /opt/venv. That leaves the venv's
# python symlink dangling: the build exports clean and every container dies
# instantly on `exec /opt/venv/bin/uvicorn: no such file or directory`, an
# error naming the script rather than the interpreter its shebang can't
# reach (this is the same failure kokoro's Dockerfile hit and fixed the same
# way). Building on the base image's own python3.12 instead -- present in
# both stages, no second interpreter tree to carry across the copy -- costs
# nothing here: the known-working chatterbox image in the fleet already runs
# on this exact base's system python3, confirming 3.12 resolves every wheel
# this build needs.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
RUN uv venv --seed --python /usr/bin/python3.12 /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
COPY --from=shared requirements.txt /tmp/requirements.txt
# requirements.txt pins the PyTorch packages to their ROCm 7.2 builds (uv.toml),
# which only this index carries.
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
      --extra-index-url https://download.pytorch.org/whl/rocm7.2
# --no-deps: chatterbox-v2's own pyproject.toml pins numpy>=1.24.0,<1.26.0
# and torch==2.5.1, both older than what this build actually installs above.
# requirements.txt installs the real runtime deps at versions confirmed to
# work here instead of letting pip downgrade to those stale pins.
RUN pip install --no-cache-dir --no-deps \
      'chatterbox-tts @ git+https://github.com/devnen/chatterbox-v2.git@master'

# gfx1151 dtype fixes for torch 2.9+ (numpy float64 leaking into float32-only
# ops) -- same two patches devnen/Chatterbox-TTS-Server carries for this
# hardware/torch pairing. Path is a glob on the venv's real install tree, not
# a literal python3.12 -- that hardcodes the interpreter minor version the
# venv happens to carry today, and a future bump silently stops matching:
# the sed exits 0, patches nothing, the image builds clean, and inference
# fails on gfx1151, the silent-failure class this project exists to catch.
RUN sed -i \
    's/wav = torch\.from_numpy(wav)$/wav = torch.from_numpy(wav).float()/' \
    /opt/venv/lib/python3.*/site-packages/chatterbox/models/s3tokenizer/s3tokenizer.py && \
    sed -i \
    's/mel_spec = self\._mel_filters\.to(self\.device) @ magnitudes/mel_spec = self._mel_filters.to(self.device).to(magnitudes.dtype) @ magnitudes/' \
    /opt/venv/lib/python3.*/site-packages/chatterbox/models/s3tokenizer/s3tokenizer.py
RUN sed -i \
    's/utt_embeds = self\.inference(mels\.to(self\.device),/utt_embeds = self.inference(mels.to(self.device).float(),/' \
    /opt/venv/lib/python3.*/site-packages/chatterbox/models/voice_encoder/voice_encoder.py

# Bakes the model weights into this layer under HF_HOME so the running
# container needs no download, no volume and no [[artifact]] -- same
# no-runtime-download posture docker/README.md documents for this image, and
# the same technique kokoro's own Dockerfile.rocm uses. The two args below
# must name the same class app.py imports, or the cache populated here misses
# at runtime; they are declared here rather than at the top of the stage so
# every layer above stays shared between the two images' builds.
#
# `docker build` attaches no /dev/kfd or /dev/dri, so ROCm torch reports no
# device here even though a checkpoint's tensors are saved as CUDA-located
# storages -- device='cpu' below only tells from_pretrained where to put the
# model AFTER load, and the failure is inside torch.load's deserialization,
# before that argument applies. The torch.load monkeypatch forces every
# load in this process to map_location=cpu regardless of what the checkpoint
# claims, without touching what from_pretrained actually requests -- so the
# same files land in the cache a real run would fetch, which is the one
# thing this step exists to guarantee.
ARG CHECKPOINT_MODULE
ARG CHECKPOINT_CLASS
ENV HF_HOME=/app/hf_cache
RUN python3 -c "\
import importlib, torch; \
_load = torch.load; \
torch.load = lambda *a, **k: _load(*a, **{**k, 'map_location': 'cpu'}); \
getattr(importlib.import_module('${CHECKPOINT_MODULE}'), '${CHECKPOINT_CLASS}') \
    .from_pretrained(device='cpu')"
# The forced aligner chatterbox_app.py places words with, baked beside the voice under
# the same cache so the runtime downloads nothing.
ENV TORCH_HOME=/app/hf_cache/torch
RUN python3 -c "from torchaudio.pipelines import MMS_FA; MMS_FA.get_model()"

FROM rocm/dev-ubuntu-24.04:7.2.4

RUN apt-get update && apt-get install -y --no-install-recommends \
      libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/app/hf_cache
ENV TORCH_HOME=/app/hf_cache/torch
# MIOpen's default kernel search picks a GemmFwdRest fallback for the vocoder's
# convolutions and warns that it was handed no workspace. FAST skips that
# search and roughly halves RTF here; NORMAL, HYBRID and DYNAMIC_HYBRID all
# measured indistinguishable from the default, so this one mode is the whole
# win -- and vocoding dominates wall time, making it the single largest lever
# on either engine. Figures: docs/engines.md.
ENV MIOPEN_FIND_MODE=FAST
ENV PATH="/opt/venv/bin:${PATH}"

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /app/hf_cache /app/hf_cache

WORKDIR /app
COPY --from=shared chatterbox_app.py .
COPY app.py .

ARG PORT
ENV PORT=${PORT}
EXPOSE ${PORT}
# `exec` so uvicorn, not the shell, is PID 1 and takes the stop signal itself.
# Exec-form CMD would leave $PORT unexpanded, and the port is a build arg.
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port $PORT"]
