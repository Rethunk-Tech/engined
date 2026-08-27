# Adapted from sagaforge-ts's docker/comfyui/Dockerfile from a read-only
# fleet-image survey (this worker's fence does not include that repo, so
# this is a reconstruction from recorded facts, not a copy). Same base,
# ComfyUI ref and rationale; confirm exact package pins against the source
# file before shipping.
#
# rocm/dev-ubuntu-24.04:7.2.4 over rocm/pytorch: ~19GB vs ~40GB. Native
# gfx1151 detection on ROCm 7.2.4 -- no HSA_OVERRIDE_GFX_VERSION anywhere in
# the fleet's ROCm images, here included.
#
# The source build is two-stage; this is single-stage until someone with
# access to the source Dockerfile confirms what the runtime stage actually
# needs copied across. Guessing that wrong ships a container that fails at
# startup instead of at build, which is worse than the extra image size.
FROM rocm/dev-ubuntu-24.04:7.2.4

ARG COMFYUI_REF=v0.9.2

RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch ${COMFYUI_REF} \
      https://github.com/comfyanonymous/ComfyUI.git /opt/comfyui

WORKDIR /opt/comfyui

# PyTorch from the ROCm 7.2 wheel index, per the fleet survey.
RUN pip install --no-cache-dir --break-system-packages \
      --index-url https://download.pytorch.org/whl/rocm7.2 \
      torch torchvision torchaudio \
    && pip install --no-cache-dir --break-system-packages -r requirements.txt

EXPOSE 8188

# --preview-method latent2rgb is not baked in here: it is spec.toml's
# `command`, appended to this ENTRYPOINT by docker.ts's buildRunArgs. Its
# absence is silent -- the relay never receives a binary preview frame
# without it -- which is why it lives in the spec, not this image or an
# operator's config.
ENTRYPOINT ["python3", "main.py", "--listen", "0.0.0.0", "--port", "8188"]
