# Engines

Every engine engined launches is a directory shipped with the repo at
`engines/<id>/`, holding a `spec.toml`, the Dockerfile when the image is
built locally, and any file the container needs mounted. `config.toml` names
the engine and supplies only what varies by install — see
[configuration.md](configuration.md).

## Container images (this box: AMD Strix Halo / gfx1151, ROCm 7.2+)

Own Dockerfile per engine — no gfx1151-validated pre-built image exists for
any of them. The exception is the two chatterbox images, which build one
`engines/chatterbox-shared/Dockerfile` twice with different `--build-arg`
values. All are two-stage: build tools (compilers, venv creation, git)
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
the decoder sees a given exact frame count.

A repeat call at an
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
this change).

Padding is silence in the frame-rate features, not the
waveform, so it adds no content of its own; only the compiled kernel choice
changes. Flagged for an operator A/B listen regardless — if anything is
audible, it would be a faint texture change in the last ~25ms of a sentence's
tail, not a click or a dropout.

**Measured and rejected: clause-splitting at commas** to shorten the first
synthesis unit. The TTFB floor is ~1.24s even for a 12-character input, so a
shorter first chunk buys almost nothing — the floor was never about how much
text the first chunk holds.

**`input_ids` bucketing, closing part of the gap above.** `app.py` also
replaces `KModel.forward_with_tokens` (`_padded_forward_with_tokens`) so
`KModel.bert`'s self-attention and `KModel.text_encoder`'s CNN stack see a
padded, `_INPUT_ID_BUCKET`-rounded (16 tokens) shape with a correctly-sized
`text_mask`, instead of one shape per exact phoneme count. Padding is exact
for these two (standard transformer attention-masking plus zero-padding
ahead of small-receptive-field convs), not an approximation the way the
decoder's zero-pad-and-trim is: `pred_aln_trg` is built by forcing every
padded position's predicted duration to exactly 0 (never the original's
`clamp(min=1)`), so a padded token can never draw a real frame.

`predictor.lstm` and `F0Ntrain` are NOT bucketed, on purpose: both run a bidirectional LSTM directly on
the un-packed sequence (`predictor.lstm`, and `F0Ntrain`'s own `self.shared`),
so its backward pass would start at the padded tail and run across it before
reaching real content, changing real positions' predicted durations by how
much padding follows them — a correctness break, not a speed tradeoff.
`predictor.lstm` is packed to the true length here to avoid that, so it
gains nothing from the bucket.
`F0Ntrain` is untouched entirely: bucketing it safely means reimplementing
it with the same packing fix, a separate change with its own correctness
pass, same as this one needed.

Correctness: `engines/kokoro/verify_padding.py` compares three pipelines per
text — two unpatched instances against each other (this box's own
call-to-call ROCm/MIOpen noise floor, which itself grows with input length:
measured 0.066/0.078/0.15 absolute across short/medium/long) and an
unpatched instance against a patched one. Sample counts matched exactly on
all three lengths tested (`sample_diff=0`); the patched/unpatched max-abs
diff (0.07/0.08/0.14) stayed within the same run's own control noise, in one
case below it.

Measured in-process (`pipeline(text)`, `torch.cuda.synchronize()` around the
call, avoiding HTTP/docker overhead) on 8 distinct novel medium/long inputs,
each container warm from its own startup sweep: **GPU was at 87-90%
utilization throughout from a concurrent llama session** (a colleague's
in-flight decode), so absolute numbers include some of that contention — but
the gap below is 1-1.8s, an order of magnitude larger than the ~0.1-0.3s
contention swings seen elsewhere, so the direction and rough size of the win
are trustworthy despite the noisy floor:

| input | before (1st call, novel length) | after (1st call, novel length) | warm floor (both) |
| ------ | ------ | ------ | ------ |
| 8 texts, 90-115 chars | 1.37-2.21s | 0.42-0.59s | 0.35-0.46s |

Before this patch, a novel input length paid nearly the same cost as a truly
cold container on every request (matching the `bert`/`text_encoder`/`lstm`/
`F0Ntrain` combined ~0.1-0.3s-each estimate this section used to cite). After
it, the first call to a novel length already lands close to the warm floor,
because its `_INPUT_ID_BUCKET` was pre-compiled by the startup warm-up sweep
along with the decoder's frame buckets. `predictor.lstm` and `F0Ntrain`'s own
share of that cost is still real and still unbucketed (see above) — it is
what keeps "after" from reaching the warm floor exactly.

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

## `streaming`, a spec key on every kind

Whether the engine can serve a streamed request:

| kind / engine | streams as | notes |
| ------ | ------ | ------ |
| `tts` app | per-chunk NDJSON frames | `"stream": true` on `POST /openai/v1/audio/speech` |
| `openai-http` server | SSE | |
| agent CLI (`claude`, `opencode`, `cursor`) | text deltas | `"stream": true` on `POST /openai/v1/chat/completions`; streams the answer text as the CLI prints it |
| `piper`, `kokoro` | sentence by sentence | streams from their own pipelines |
| `chatterbox-multi`, `chatterbox-en` | one `generate()` call per sentence | runs when the door asks for chunks, so the first sentence's audio goes out while the rest is still sampling -- a single-sentence request is one call either way |
| `llama` | SSE | |
| `whisper` | one NDJSON frame per segment as it decodes | `"stream": "true"` on `POST /openai/v1/audio/transcriptions`; this is whisper.cpp's own new-segment callback, not a finished transcript cut into pieces -- its wrapper reaches that callback through whisper-cli, because whisper-server buffers the whole body |
| `comfy` | does not stream | its proxy is not a content endpoint |

It lives in `spec.toml` because it is a property of the engine's own app, not
of an install — the same reason `serves` does — and a `[[route]]` may override
it for one provider tier that cannot chunk what its siblings can. Off unless a
spec says otherwise, which is the safe direction: an engine that
under-declares costs a caller the early audio it could have had, while one
that over-declares costs it a 502 on every request.

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

`src/visionProbe.ts` is that check, and two things run it. `test/local/llama.test.ts`
drives it against the router directly, and the install ships it as a weekly
`systemd --user` timer (`engined-vision-probe.timer`) that runs
`main.js --vision-probe` against the live door -- every vision address the
model menu lists, found by its `role`. Either way it is a two-colour PNG built
in code (no fixture file to go stale, a fresh image every run) sent through
the OpenAI chat verb as an `image_url` data URI, asserting the reply names
both halves **and their order**.

The timer is why this criterion no longer depends on someone remembering it.
A failure is a failed unit with the reply in journald; a box with no vision
route configured gets a line saying so and a clean exit, not a standing red.

The order is the point. A single flat colour is a weak probe for this defect
specifically: a description that never read the image still has only a handful
of colour words to reach for, so a confident wrong answer lands on the
expected one often enough that passing means little. Two halves in a stated
left-to-right order is not something guessing reaches.

That still proves fidelity only for this GGUF, this mmproj build and this one
synthetic image -- re-check with your own consumer's real images before
trusting the vision role for them.

## Occupancy

One resident model per role (`chat`, `vision`, `embedding`), with explicit
same-role unload rather than a GPU-wide semaphore. `models_max` is first-class
config and fatal at parse if it drops below the number of distinct roles
actually configured — below that floor, eviction silently reverts to
llama.cpp's own cross-role LRU.

Measured on this box: one resident 35B GGUF costs ~27 GiB of the 133 GB
shared pool, and idle-stop returns it.
