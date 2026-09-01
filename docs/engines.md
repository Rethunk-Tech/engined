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

`engines/llama/`, image `engined-llama-cpp:local`. Builds
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

### Chatterbox Multilingual (`chatterbox-multi`)

`engines/chatterbox-multi/`. Follows ComfyUI's base pattern. Installs
`chatterbox-tts` (devnen's `chatterbox-v2` fork, which carries gfx1151 dtype
fixes) with `--no-deps`, then its real runtime dependencies at versions that
work on Python 3.12 / torch 2.13 — its own `pyproject.toml` pins
`numpy<1.26` (no Python 3.12 wheel exists at all) and `torch==2.5.1`,
neither usable here. ~29 GB. Runs `ChatterboxMultilingualTTS`, whose
`generate()` takes a required `language_id`.

### Chatterbox Turbo (`chatterbox-en`)

`engines/chatterbox-en/`. The same base and ROCm posture as Chatterbox
Multilingual, but a different checkpoint -- `ResembleAI/chatterbox-turbo`,
whose diffusion decoder runs one step where the multilingual model runs ten.
Runs `ChatterboxTurboTTS`, whose `generate()` takes no language parameter at
all -- English-only by construction, not by convention: a Japanese sentence
fed to it produces 15.76s of degenerate babble against 2.76s of correct audio
from the multilingual model on the same input. Kept alongside Chatterbox
Multilingual rather than replacing it; both images ship.

It is the faster of the two chatterbox engines, and the only chatterbox that
runs faster than realtime here. It is not the fastest TTS engine on this box:
kokoro is an order of magnitude ahead of it (see the cross-engine table below),
and piper further still.

`MIOPEN_FIND_MODE` measured, median of three runs after warm-up, same input:

| engine | `MIOPEN_FIND_MODE` | RTF | realtime |
| ------ | ------ | ------ | ------ |
| chatterbox-multi | default | 2.48 | 0.40x |
| chatterbox-multi | FAST | 1.06 | 0.94x |
| chatterbox-en | default | 1.29 | 0.78x |
| chatterbox-en | FAST | 0.62 | 1.52-1.60x |

### Every TTS engine, same input, measured in isolation

One 123-character phrase, warm, with every other engine container stopped so
nothing shares the GPU:

| engine | x realtime | reps |
| ------ | ------ | ------ |
| piper | 26.7-34.9x | 4 |
| kokoro | 21.1x (+/-0.5%) | 8 |
| chatterbox-en | 1.5-1.6x | 4 |
| chatterbox-multi | 0.8-0.9x | 4 |

**kokoro is the second-fastest engine here, not a slow one.** Its reputation
for latency came from a 1.24s time to first byte that was per-shape kernel
compilation, not throughput -- see `engines/kokoro/app.py`. Nothing recorded
its actual rate until this table.

**These are isolated-engine ceilings.** Idle co-residency is free -- kokoro
measures 21x alone and 20-21x with chatterbox resident -- but a second engine
actively synthesizing costs 10-30%. A ratio quoted without saying what else was
running is not reproducible.

Piper's ~46x elsewhere in this document is its long-input figure; the 123-char
phrase above puts it near 32x, and a one-line reply lower again.

**These ratios are a ceiling, not a budget.** They were taken on input long
enough to amortize a fixed per-request cost; on a short reply the same engine
measures well below them -- chatterbox-en lands at 0.86-1.20x on a 12-char
input and 1.11-1.16x on 41 chars. Still realtime or better, but do not size a
short-reply latency budget from the headline figure.

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
(`/dev/kfd`, `/dev/dri`, `video`), not the Vulkan-only pair llama uses.
Ported from sagaforge-ts's `Dockerfile.rocm` rather than the vendored
`ghcr.io/remsky` image: that one speaks OpenAI's `/v1/audio/speech` natively,
while the audio door already translates the NDJSON `/v1/tts` contract this
build speaks, and taking it would need a second path through a door meant to
have exactly one. ~29.7 GB. Weights baked at build time. Fixed voice packs
only, no cloning.

Being a ROCm engine, it contends for the box's single GPU like ComfyUI and
llama.cpp do. Piper is the CPU voice, and that is the reason to reach for it
instead when speech has to run while a large GGUF stays resident.

#### Time-to-first-audio: the floor was MIOpen, not FLOPs

Kokoro's own vocoder (`KModel.decoder`, an ISTFTNet-style HiFi-GAN) yields one
array per sentence, so with `chunks: true` any RTF win lands directly on
TTFB. Profiling on this box (gfx1151/ROCm 7.2) found the ~1.2-3.7s TTFB was
not FLOPs at all: it is MIOpen JIT-compiling a fresh kernel the first time
the decoder sees a given exact frame count. A repeat call at an
already-compiled shape runs the same decoder in ~0.15s; a never-before-seen
one costs ~1.1-3s regardless of how short the text is (measured: a
14-phoneme "Hi there friend" cost as much as a 71-phoneme sentence, and two
inputs differing by a single character both paid the full cost). Since
duration is predicted per phoneme rather than quantized, almost every
distinct sentence produces a distinct frame count, so production traffic
hit a cold shape on nearly every request — fp16 and `torch.compile` were
never going to fix this, because the cost was never in the matrix multiplies.

`app.py` wraps `model.decoder` in `_BucketedDecoder`: it rounds the frame
count up to a 32-frame bucket with zero-padding, runs the real decoder once,
and trims the output back to the true sample count (output samples are
exactly linear in frame count, confirmed empirically, so the trim point is
exact). This collapses the practical shape space to a small enumerable set,
and a startup warm-up (before `/health`, same invariant `KPipeline()`
already relies on) pre-pays the compile for that whole set. `spec.toml`
persists MIOpen's on-disk kernel cache in a docker-managed named volume so a
container recreated by idle-stop does not re-pay it from zero; `config.toml`
gives kokoro `ready_timeout_s = 120` (default 60) so the warm-up has room.

Measured through the door (`POST /openai/v1/audio/speech`, `stream: true`,
warm engine, distinct texts, median of runs), before vs. after:

| input length | before | after |
| ------ | ------ | ------ |
| ~15 ch | 1.24-1.60s | 0.29-0.58s |
| ~40 ch | 1.22-1.27s | 0.34-0.66s |
| ~55 ch | 1.24-1.86s | 0.36-1.48s |
| ~135 ch | 3.73s (op's baseline) | 1.75s |

Correctness: verified numerically against the unpadded decoder on real
kokoro output — the trimmed region matches to ~1e-8, and the padding-induced
difference elsewhere is the same order of magnitude as the run-to-run noise
this ROCm/MIOpen backend already exhibits between two calls of *identical*
input with no padding involved at all (up to ~0.07 absolute on a few
samples — this backend is not bit-deterministic call to call, independent of
this change). Padding is silence in the frame-rate features, not the
waveform, so it adds no content of its own; only the compiled kernel choice
changes. Flagged for an operator A/B listen regardless — if anything is
audible, it would be a faint texture change in the last ~25ms of a sentence's
tail, not a click or a dropout.

**Measured and rejected: clause-splitting at commas** to shorten the first
synthesis unit. The TTFB floor is ~1.24s even for a 12-character input, so a
shorter first chunk buys almost nothing — the floor was never about how much
text the first chunk holds.

**Not fixed here, and worth naming so it isn't re-investigated as a mystery:**
bucketing only covers the decoder. `KModel.bert`, `predictor.text_encoder`,
`predictor.lstm` and `F0Ntrain` each pay their own smaller MIOpen JIT cost
(measured ~0.1-0.3s each) on a novel *input* phoneme length, unbucketed —
which is why medium/long inputs above still show real, if reduced, variance.
Closing that gap means padding `input_ids` the same way, which the model's
existing `text_mask`/`attention_mask` plumbing could plausibly support, but
touches the alignment construction (`pred_aln_trg`) and needs its own
correctness pass — left as a follow-up rather than folded into this change.

### Piper

`engines/piper/`. The one engine with no GPU flags at all: an ONNX voice small
enough that onnxruntime's CPU provider is the right answer, which is what makes
it the voice to reach for while a large GGUF stays resident. ~0.5 GB. Voice
baked at build time.

Faster than realtime by a wide margin, and by more than the GPU engines above:
measured through the door, median of three runs, warm, on a three-sentence
input, RTF 0.022 -- 8.64s of audio in 0.19s, about 46x realtime. That is a
different measurement from the ROCm table above (no GPU contention, no MIOpen
search), which is why it is quoted separately rather than added as a row.

That 46x is the long-input figure and it climbs with length: measured 11.1x on
12 characters, 13.5-18.7x on 41, and 23.5-31.6x on 155. **Cite ~11-20x for a
one-line reply.** It changes no decision -- piper's absolute latency is
65-390ms either way, which is nobody's bottleneck -- but the headline number
overstates what a short reply actually costs.

Its voice synthesizes at **22050 Hz**, not the 24000 kokoro uses. Nothing
inside a WAV cares, but a streamed `audio/L16` reply has only the content type
to say so -- see [http-api.md](http-api.md).

### Whisper (`whisper`, routes `medium.en` and `small.en`)

`engines/whisper/`, running `engined-whisper:local` — a two-line Dockerfile
over a pinned `ghcr.io/ggml-org/whisper.cpp` digest, adding the `EXPOSE` the
upstream image omits and engined's port discovery requires. One engine, two
model-bearing routes rather than two engines: same image, same `models_dir`,
differing only in which `-m` weights file starts the container, so a second
copy of the pinned digest would only be a second thing to keep in step.
Switching between the two routes is a stop-and-restart, refused with 409
while a transcription is in flight.

Which route a consumer addresses is a latency choice, and it is a real
frontier rather than a big/small pair. Measured on this box over 8 recorded
speech clips (4.3–8.7s, known transcripts, scored after normalising numeral
formatting so "twenty five" against "25" is not counted a mishearing), median
encode per clip:

| route | model file | WER | ms/clip |
| ------ | ------ | ------ | ------ |
| `medium.en` | `ggml-medium.en-q8_0` | 11.5% | 2715 |
| `small.en` | `ggml-small.en-q8_0` | 13.5% | 929 |
| — | `ggml-large-v3-turbo-q8_0` | 13.5% | 4063 |

The third row is not served: the large multilingual model is beaten on
accuracy *and* speed by `medium.en`, so nothing points at it. Model load is
41–196ms across all three — encode is the entire cost, and size does not buy
back its own load.

**Both routes are English-only.** Neither pins `-l` (language stays a
per-request field), but a request naming another language is still decoded by
English-trained weights. Non-English work belongs on the remote STT engine,
or on a multilingual model that is not currently configured.

Both routes mount the same `models_dir`, so the Silero VAD model both load
is one file on disk, not two.

## `streaming`, a tts-only spec key

Whether an engine's `/v1/tts` emits per-chunk NDJSON frames, and so whether
`"stream": true` on `POST /openai/v1/audio/speech` is servable by it. `piper` and
`kokoro` set `streaming = true`; `chatterbox-multi` and `chatterbox-en` omit it,
because a single blocking `generate()` has no piece to forward before the
last one.

It lives in `spec.toml` because it is a property of the engine's own app, not
of an install — the same reason `serves` does. It is fatal at parse on any
other kind: only `/openai/v1/audio/speech` has a chunk contract, so anywhere else
the key would be read, reported and honoured by nothing. Off unless a spec
says otherwise, which is the safe direction: an engine that under-declares
costs a caller the early audio it could have had, while one that
over-declares costs it a 502 on every request.

`GET /engined/v1/engines` reports it per engine, so no consumer has to carry its own
list of which engines can stream — see [http-api.md](http-api.md).

## Three specs carry a detail that fails silently

Dropping any of these produces no error, just wrong behaviour:

- Comfy's `--preview-method latent2rgb`, without which the relay's preview
  frames never arrive.
- Kokoro's entrypoint override, without which its image floods the log at
  debug level.
- Whisper's `--inference-path`, which is the only reason that engine's routes
  are OpenAI-shaped.

The agentic launch flags are the read-only guarantee itself. All of these
belong in a file that ships and diffs, not one an operator edits.

## Vision fidelity (llama, Vulkan)

Two upstream Vulkan defects affect the vision role. One crashes llama-server
and has a workaround engined already applies (`no-mmproj-offload`, see
`engines/llama/spec.toml`).

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
