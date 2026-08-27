# Verified against sagaforge-ts's docker/comfyui/Dockerfile (read-only fleet
# access, not a summary). Two-stage, restored from the prior single-stage
# reconstruction now that the runtime copy can be confirmed correct: the
# runtime stage needs exactly /opt/venv (the ROCm PyTorch install) and
# /opt/comfyui (the cloned checkout plus its installed deps, since pip
# installs into the venv the checkout is built alongside) -- both self
# contained, no other build-only state leaks into ComfyUI's own imports.
#
# rocm/dev-ubuntu-24.04:7.2.4, not rocm/pytorch or the "-complete" tag: the
# official PyTorch ROCm wheel is self-contained (bundles its own
# MIOpen/rocBLAS/rocRAND/etc.), so a base that also ships those duplicates
# them for no benefit. Measured on the source box: rocm/pytorch is 40GB;
# this base plus the wheel is 19GB, both correctly detect gfx1151. Native
# gfx1151 detection -- no HSA_OVERRIDE_GFX_VERSION anywhere in the fleet's
# ROCm images, here included.
FROM rocm/dev-ubuntu-24.04:7.2.4 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3-venv python3-dev build-essential git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
RUN pip install --no-cache-dir torch torchvision torchaudio \
      --index-url https://download.pytorch.org/whl/rocm7.2

ARG COMFYUI_REF=v0.9.2
WORKDIR /opt/comfyui
RUN git clone --branch ${COMFYUI_REF} --depth 1 \
      https://github.com/comfyanonymous/ComfyUI.git . \
    # torch/torchvision/torchaudio already installed above from the ROCm
    # index -- ComfyUI's own requirements.txt pins CUDA wheels for those, and
    # letting pip see both would fight the ROCm install just made. requests:
    # imported by app/frontend_management.py but missing from ComfyUI's own
    # requirements.txt as of v0.9.2 -- confirmed by inspecting the file, not
    # a guess.
    && grep -viE '^(torch|torchvision|torchaudio)([<>=~! ].*)?$' requirements.txt \
      > requirements.rocm.txt \
    && pip install --no-cache-dir -r requirements.rocm.txt requests

FROM rocm/dev-ubuntu-24.04:7.2.4

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/comfyui /opt/comfyui
ENV PATH="/opt/venv/bin:${PATH}"
WORKDIR /opt/comfyui

EXPOSE 8188

# --preview-method latent2rgb is not baked in here: it is spec.toml's
# `command`, appended to this ENTRYPOINT by docker.ts's buildRunArgs. Its
# absence is silent -- the relay never receives a binary preview frame
# without it -- which is why it lives in the spec, not this image or an
# operator's config.
ENTRYPOINT ["python3", "main.py", "--listen", "0.0.0.0", "--port", "8188"]
