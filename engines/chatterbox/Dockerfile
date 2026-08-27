# Adapted from the fleet's own chatterbox build: rocm/dev-ubuntu-24.04:7.2.4,
# chatterbox-tts from devnen/chatterbox-v2, with the two gfx1151 dtype patches
# Strix Halo needs -- ROCm on this GPU generation does not carry float64
# kernels for these two modules, so they are downcast to float32 in place.
# Weights are baked in at build time via HF_HOME, so the running container
# needs no model volume and no [[artifact]].
FROM rocm/dev-ubuntu-24.04:7.2.4

ENV DEBIAN_FRONTEND=noninteractive
ENV HF_HOME=/app/hf_cache

RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN git clone --depth 1 https://github.com/devnen/chatterbox-v2.git . \
    && pip install --no-cache-dir --break-system-packages . uvicorn fastapi

# Strix Halo (gfx1151) dtype fix: these two modules assume float64 support
# this GPU generation's ROCm build does not have.
RUN find /app -name s3tokenizer.py -exec sed -i 's/float64/float32/g' {} + \
    && find /app -name voice_encoder.py -exec sed -i 's/float64/float32/g' {} +

# Bakes the model weights into this layer under HF_HOME so no download or
# volume is needed at container start.
RUN python3 -c "from chatterbox.tts import ChatterboxTTS; ChatterboxTTS.from_pretrained(device='cpu')"

EXPOSE 8004

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8004"]
