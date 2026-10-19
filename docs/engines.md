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

A baked wrapper edit (`app.py`, the Dockerfile) is live only after a rebuild
plus `docker rm -f engined-<id>`: a running container keeps serving the old
image until it is removed, and `scripts/install.sh` redeploys the daemon
only, never engine images. Rebuild with the `docker build` line a missing
image reports as its fix — it already carries that spec's
`--build-context`/`--build-arg` — then probe through the door rather than
trusting the build's exit code. Every Python engine's Dockerfile does
`COPY --from=ghcr.io/astral-sh/uv:latest`, so the layer cache dies whenever
that tag moves and the rebuild re-downloads ROCm torch (~6 GB): about ten
minutes for kokoro, longer for chatterbox. Never rebuild speculatively.

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

Answers `POST /openai/v1/images/generations` from the graph it ships
(`text-to-image.json`), and everything that graph cannot express through the
mediated proxy — see [http-api.md](http-api.md#images).

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

`engines/chatterbox-en/`. The same base and ROCm posture as Chatterbox Multilingual with the
`ResembleAI/chatterbox-turbo` checkpoint, whose diffusion decoder runs one step where the
multilingual model runs ten. `ChatterboxTurboTTS.generate()` takes no language, so it is
English only by construction (other languages come out as babble), and both images ship.

It is the only chatterbox faster than realtime here. `MIOPEN_FIND_MODE=FAST`
(`engines/chatterbox-shared/Dockerfile`) roughly halves synthesis time: MIOpen's default search
falls back to `GemmFwdRest` for the vocoder's convolutions, and FAST skips that search; the other
modes match the default. Float16 or bfloat16 autocast is slower on this box, and fewer
`n_cfm_timesteps` clips the output.

Turbo's output is markedly quieter than the multilingual model's (peak about 0.4 against 0.9), so
a consumer switching between them hears a level change.

### Relative TTS speed

Piper and kokoro run tens of times faster than realtime, chatterbox-en a little faster than
realtime and chatterbox-multi a little slower. These are ceilings for long input with nothing else
on the GPU: a short reply pays a fixed per-request cost, and a second engine synthesizing at the
same time costs 10-30% (an idle resident engine costs nothing).

### Kokoro

`engines/kokoro/`. Follows ComfyUI's base pattern — `rocm/dev-ubuntu-24.04:7.2.4`
plus the official PyTorch ROCm wheel — and takes the full GPU flags
(`/dev/kfd`, `/dev/dri`, `video`), not the Vulkan-only pair llama uses.
Ported from the fleet Comfy ROCm image rather than the vendored
`ghcr.io/remsky` image: that one speaks OpenAI's `/v1/audio/speech` natively,
while the audio door already translates the NDJSON `/v1/tts` contract this
build speaks, and taking it would need a second path through a door meant to
have exactly one. ~29.7 GB. Weights baked at build time. Fixed voice packs
only, no cloning.

Being a ROCm engine, it contends for the box's single GPU like ComfyUI and
llama.cpp do. Piper is the CPU voice, and that is the reason to reach for it
instead when speech has to run while a large GGUF stays resident.

#### Time to first audio

Kokoro yields one array per sentence, so with `chunks: true` its first audio waits on the first
sentence. MIOpen JIT-compiles a kernel the first time the decoder sees an exact frame count, so the
startup warm-up sweeps the practical range of shapes and the text encoder pads input to
`_INPUT_ID_BUCKET` buckets (`engines/kokoro/app.py`): a novel length lands near the warm floor.

### Piper

`engines/piper/`. The one engine with no GPU flags at all: an ONNX voice small
enough that onnxruntime's CPU provider is the right answer, which is what makes
it the voice to reach for while a large GGUF stays resident. ~0.5 GB. The
default voice is baked at build time. With a `models_dir`, a route's `filename`
names another Piper voice there (the `.onnx` with its `.onnx.json` beside it; any
voice from huggingface.co/rhasspy/piper-voices works) and the start loads it
instead, patching a copy for word timings as the build does for the baked one.

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
or on a multilingual model this config does not name.

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

The other has none. **A vision request can return a confident, plausible,
wrong description of the image, with nothing in the response to signal it.**
Three live checks did not reproduce that Vulkan fault. Those checks are three
data points, not a fix, and the fault stays unproven for any image this probe
did not build.

`src/probe.ts` is the regression for a silent mis-description of an image
whose content is known because this repo built it. Two things run it.
`test/local/llama.test.ts` drives the live check against the router directly,
and the install ships it as a weekly `systemd --user` timer
(`engined-probe.timer`) that runs `main.js --probe` against the live door --
every vision address the model menu lists, found by its `role`. Both send an
image built in code (no fixture file to go stale, a fresh one every run)
through the OpenAI chat verb as an `image_url` data URI.

Which image depends on the route's `vision` kind, because a vision role says
an address takes an image and not what its model does with one:

- `describe` gets the two-colour PNG, and must name both halves **and their
  order**.
- `read` gets a freshly generated 8-digit string drawn by a 5x7 bitmap font,
  and must read it back.

Sending either question to the other model fails a model that is working.
Measured live: asked to name the two colours, PaddleOCR-VL answers "the color
of the right half is the color of the right half on the second" -- it reads
characters, it does not describe scenes. Both routes on this box prove through
their own check.

The order is the point. A single flat colour is a weak probe for this defect
specifically: a description that never read the image still has only a handful
of colour words to reach for, so a confident wrong answer lands on the
expected one often enough that passing means little. Two halves in a stated
left-to-right order is not something guessing reaches. The verdict still only
reads those two words and their order. A wrong scene that happens to say red
before blue passes. That is the limit of the check.

A green result proves fidelity only for this GGUF, this mmproj build and this
one synthetic image. Re-check with your own consumer's real images before
trusting the vision role for them, and again when the image, the GGUF or the
mmproj build changes. Until that check, the Vulkan fault is unproven. The
other roles carry no equivalent caveat.

The timer means this criterion does not depend on someone remembering it.
A failure is a failed unit with the reply in journald. A box with no vision
route configured gets a line saying so and a clean exit, not a standing red.
That clean exit proved nothing about fidelity. A vision route that is
configured but `unavailable` fails the probe instead: the run asked it
nothing, and a skip is not a pass.

The local tier is stricter on a missing route. When
`test/local/llama.test.ts` is otherwise going to drive the container, no
vision route throws before any test runs, so that run cannot exit green
having skipped the criterion. A skipped tier (`ENGINED_LOCAL` unset, the
image not built, the config not loadable) also proved nothing about the live
model. The mis-description regression in that file does not need the model:
a cat, a single colour, an empty reply, and the halves named backwards all
fail `visionVerdict`, the prompt does not contain the answer words, and that
test is not behind the container skip. It does not substitute for the live
check.

## Occupancy

One resident model per role (`chat`, `vision`, `embedding`, `rerank`), with explicit
same-role unload rather than a GPU-wide semaphore. Each role has its own lane; the lanes
share a budget of `models_max` resident models. When fewer slots than roles are in use, a
cold role evicts the least recently used idle role, never one with requests in flight, and
waits in arrival order when every holder is busy. `models_max` is first-class config and
fatal at parse if it drops below the number of distinct `keep_resident` roles.

Measured on this box: one resident 35B GGUF costs ~27 GiB of the 133 GB
shared pool, and idle-stop returns it.
