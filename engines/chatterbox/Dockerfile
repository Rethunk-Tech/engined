# Verified against sagaforge-ts's docker/chatterbox/Dockerfile (read-only
# fleet access, not a summary). Two-stage, same pattern as docker/comfyui:
# minimal rocm/dev-ubuntu-24.04 (not rocm/pytorch or "-complete" -- the
# official PyTorch ROCm wheel already bundles MIOpen/rocBLAS/etc., so a base
# that also ships those just duplicates them). Build tools never reach the
# runtime image. app.py and requirements.txt are vendored verbatim from that
# same directory -- app.py is sagaforge's own FastAPI wrapper speaking the
# NDJSON /v1/tts contract src/audio.ts translates; the upstream devnen repo
# has no compatible HTTP surface of its own.
FROM rocm/dev-ubuntu-24.04:7.2.4 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3-venv python3-dev build-essential git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
RUN pip install --no-cache-dir torch torchvision torchaudio \
      --index-url https://download.pytorch.org/whl/rocm7.2

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
# --no-deps: chatterbox-v2's own pyproject.toml pins numpy<1.26 (no Python
# 3.12 wheel exists, unbuildable there) and torch==2.5.1 (we run newer on
# purpose) -- requirements.txt above installs its real deps at versions that
# actually work here instead.
RUN pip install --no-cache-dir --no-deps \
      'chatterbox-tts @ git+https://github.com/devnen/chatterbox-v2.git@master'

# gfx1151 dtype fixes for torch 2.9+ (numpy float64 leaking into float32-only
# ops) -- same two patches devnen/Chatterbox-TTS-Server carries for this
# hardware/torch pairing. Paths are the venv's real install tree, not a
# find-by-filename guess: getting these wrong builds clean and then fails at
# inference on gfx1151, the silent-failure class this project exists to catch.
RUN sed -i \
    's/wav = torch\.from_numpy(wav)$/wav = torch.from_numpy(wav).float()/' \
    /opt/venv/lib/python3.12/site-packages/chatterbox/models/s3tokenizer/s3tokenizer.py && \
    sed -i \
    's/mel_spec = self\._mel_filters\.to(self\.device) @ magnitudes/mel_spec = self._mel_filters.to(self.device).to(magnitudes.dtype) @ magnitudes/' \
    /opt/venv/lib/python3.12/site-packages/chatterbox/models/s3tokenizer/s3tokenizer.py
RUN sed -i \
    's/utt_embeds = self\.inference(mels\.to(self\.device),/utt_embeds = self.inference(mels.to(self.device).float(),/' \
    /opt/venv/lib/python3.12/site-packages/chatterbox/models/voice_encoder/voice_encoder.py

# Bakes the model weights into this layer under HF_HOME so the running
# container needs no download, no volume and no [[artifact]] -- same
# no-runtime-download posture docker/README.md documents for this image, and
# the same technique kokoro's own Dockerfile.rocm uses. Must match app.py's
# real import (ChatterboxMultilingualTTS from chatterbox.mtl_tts, not the
# English-only ChatterboxTTS) or the cache populated here misses at runtime.
ENV HF_HOME=/app/hf_cache
RUN python3 -c "from chatterbox.mtl_tts import ChatterboxMultilingualTTS; ChatterboxMultilingualTTS.from_pretrained(device='cpu')"

FROM rocm/dev-ubuntu-24.04:7.2.4

RUN apt-get update && apt-get install -y --no-install-recommends \
      libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/app/hf_cache
ENV PATH="/opt/venv/bin:${PATH}"

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /app/hf_cache /app/hf_cache

WORKDIR /app
COPY app.py .

EXPOSE 8004
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8004"]
