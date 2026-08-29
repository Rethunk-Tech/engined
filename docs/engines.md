# Engines

Every engine engined launches is a directory shipped with the repo at
`engines/<id>/`, holding a `spec.toml`, the Dockerfile when the image is
built locally, and any file the container needs mounted. `config.toml` names
the engine and supplies only what varies by install — see
[configuration.md](configuration.md).

## Container images (this box: AMD Strix Halo / gfx1151, ROCm 7.2+)

Own Dockerfile per engine — no gfx1151-validated pre-built image exists for
any of them. All are two-stage: build tools (compilers, venv creation, git)
never reach the runtime image.

### llama.cpp

`engines/local-llama/`, image `engined-llama-cpp:local`. Builds
`llama-server` from [Nathanw1014/llama.cpp](https://github.com/Nathanw1014/llama.cpp)'s
`strix-halo-vulkan` branch (fork of upstream, MIT) — Strix-Halo Vulkan work
not yet upstream.

Chosen over a same-generation ROCm build after benchmarking both on a
realistic long-context prompt: it ties ROCm's prefill throughput while
keeping Vulkan's ~14% decode edge, the best of 6 candidate images. Only
`/dev/dri` is needed (no `/dev/kfd`), native gfx1151 — no ROCm GFX-version
override. ~938 MB.

### ComfyUI

`engines/comfy/`. Bases on `rocm/dev-ubuntu-24.04:7.2.4` — the minimal
ROCm/HIP runtime, not `rocm/pytorch` or the `-complete` tag — plus the
official PyTorch ROCm wheels, which are self-contained and would otherwise
duplicate a fuller base's own ROCm math libraries. GPU detected as `Radeon
8060S Graphics : native`. ~28.9 GB, down from 41.1 GB on `rocm/pytorch`.

### Chatterbox

`engines/chatterbox/`. Follows ComfyUI's base pattern. Installs
`chatterbox-tts` (devnen's `chatterbox-v2` fork, which carries gfx1151 dtype
fixes) with `--no-deps`, then its real runtime dependencies at versions that
work on Python 3.12 / torch 2.13 — its own `pyproject.toml` pins
`numpy<1.26` (no Python 3.12 wheel exists at all) and `torch==2.5.1`,
neither usable here. ~29 GB.

### Chatterbox Turbo (`chatterbox-fast`)

`engines/chatterbox-fast/`. The same base and ROCm posture as Chatterbox, but
a different checkpoint -- `ResembleAI/chatterbox-turbo`, whose diffusion
decoder runs one step where the multilingual model runs ten. English-only:
Turbo's `generate()` takes no `language_id`, so there is no language to plumb.
Kept alongside Chatterbox rather than replacing it; both images ship.

It is the only TTS engine here that is faster than realtime on this box.
Measured, median of three runs after warm-up, on the same input:

| engine | `MIOPEN_FIND_MODE` | RTF | realtime |
| ------ | ------ | ------ | ------ |
| chatterbox | default | 2.48 | 0.40x |
| chatterbox | FAST | 1.06 | 0.94x |
| chatterbox-fast | default | 1.29 | 0.78x |
| chatterbox-fast | FAST | 0.62 | 1.52-1.60x |

Roughly half the gain is the model and half is `MIOPEN_FIND_MODE=FAST`, set in
this image's Dockerfile. MIOpen's default search picks a `GemmFwdRest`
fallback for the vocoder's convolutions and warns that it was handed no
workspace; FAST skips that search. `NORMAL`, `HYBRID` and `DYNAMIC_HYBRID` all
measured indistinguishable from the default, so this is one specific mode
rather than a tuning dial.

Two things that were measured and did **not** help, recorded so they are not
retried: autocast to float16 or bfloat16 made synthesis ~1.5x *slower* (and
bfloat16 tripped a token-repetition warning), despite gfx1151's known float32
throughput gap; and cutting `n_cfm_timesteps` to 1 moved RTF only ~6% while
driving peak amplitude to 1.40, which clips.

Turbo's output is markedly quieter than the multilingual model's -- peak
around 0.33-0.45 against 0.83-1.00 -- so a consumer switching between them
hears a level change.

### Kokoro

`engines/kokoro/`. Follows ComfyUI's base pattern — `rocm/dev-ubuntu-24.04:7.2.4`
plus the official PyTorch ROCm wheel — and takes the full GPU flags
(`/dev/kfd`, `/dev/dri`, `video`), not the Vulkan-only pair local-llama uses.
Ported from sagaforge-ts's `Dockerfile.rocm` rather than the vendored
`ghcr.io/remsky` image: that one speaks OpenAI's `/v1/audio/speech` natively,
while the audio door already translates the NDJSON `/v1/tts` contract this
build speaks, and taking it would need a second path through a door meant to
have exactly one. ~29.7 GB. Weights baked at build time. Fixed voice packs
only, no cloning.

Being a ROCm engine, it contends for the box's single GPU like ComfyUI and
llama.cpp do. Piper is the CPU voice, and that is the reason to reach for it
instead when speech has to run while a large GGUF stays resident.

## Three specs carry a detail that fails silently

Dropping any of these produces no error, just wrong behaviour:

- Comfy's `--preview-method latent2rgb`, without which the relay's preview
  frames never arrive.
- Kokoro's entrypoint override, without which its image floods the log at
  debug level.
- Whisper's `--inference-path`, which is the only reason it is OpenAI-shaped.

The agentic launch flags are the read-only guarantee itself. All of these
belong in a file that ships and diffs, not one an operator edits.

## Vision fidelity (local-llama, Vulkan)

Two upstream Vulkan defects affect the vision role. One crashes llama-server
and has a workaround engined already applies (`no-mmproj-offload`, see
`engines/local-llama/spec.toml`).

The other has none: **a vision request can return a confident, plausible,
wrong description of the image, with nothing in the response to signal it.**
It did not reproduce across three live checks, which is three data points and
not a fix — nothing in this repo can detect a recurrence, because a wrong
description is indistinguishable from a right one without ground truth.

If you are wiring a consumer to the vision role, check output fidelity
against an image whose content you already know, and re-check it when the
image, the GGUF or the mmproj build changes. Treat vision as unproven until
you have done that for your own consumer; the other roles carry no equivalent
caveat.

## Occupancy

One resident model per role (`chat`, `vision`, `embedding`), with explicit
same-role unload rather than a GPU-wide semaphore. `models_max` is first-class
config and fatal at parse if it drops below the number of distinct roles
actually configured — below that floor, eviction silently reverts to
llama.cpp's own cross-role LRU.

Measured on this box: one resident 35B GGUF costs ~27 GiB of the 133 GB
shared pool, and idle-stop returns it.
