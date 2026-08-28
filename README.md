<h1 align="center">engined</h1>

<div align="center">

One local engine broker for the whole workstation.

</div>

---

`TODO.md` is the scope, one entry per feature, and is authoritative. This
file says only what the service is.

`config.example.toml` is a worked, committed configuration covering every
engine this repo ships a spec for. Copy it to
`$XDG_CONFIG_HOME/engined/config.toml` and edit it for your machine — it is
kept parsing against the real config loader by `src/config-example.test.ts`,
so it is never stale.

**The ownership line.** `engined` owns the engine list and its shape, secret
resolution, aliases, chain ordering and fallback, OpenAI `model` dispatch,
llama.cpp occupancy, container lifecycle for every managed engine, the spec
directory that describes each one, invocation of every kind including
`agentic-cli` and the read-only launch arguments that make that safe, and
provenance. Consumers own prompts, context assembly, output parsing, Comfy
graphs, which chain or model string to send, and writing to disk whatever
they keep from what an agent returned. **`engined` knows nothing about the
task**: if changing a feature's prompt would require an `engined` change, the
line has been drawn wrong.

Agentic CLIs are an engine *kind*, not a separate API: they are launched with
writing structurally disabled, so they read a repository and return text like
any other completion. `engined` never writes to a caller's worktree. The
guarantee is **integrity, not confidentiality**: `workdir` says where an
agent begins, not what it may read. Measured — under the full read-only
floor, an agent asked for `/etc/hostname` returns it, with no permission
denial. What an agentic call cannot do is *change* the caller's tree; what it
emphatically can do is read anything this uid can open — every private key,
the `gh` identity, the credentials of the CLI being run — and send it
wherever a chain ends. A workdir allowlist bounds nothing meaningful, since
the fleet's source lives inside any plausible root. A local process already
reads those files directly; what `engined` adds is convenience and an egress
path. Adding a second, less-trusted caller is the moment this stops being
acceptable.

## Model selection

OpenAI `model` accepts a bare GGUF id or alias (only when exactly one engine
serves it — two or more is a 400 listing the qualified forms), an engine id,
a `chain-<name>`, or `@/<engine>/<model>` — the canonical, fully-qualified
form, and the only one a chain hop may use. The `@/` prefix exists because
the obvious spelling collides with reality: a Hugging Face id is already
`org/model`, and a GGUF filename this config carries is the same shape, so a
bare `engine/model` cannot be told apart from a repo name. `@/` is not
decoration — it is what makes the namespace unambiguous without banning
slashes from either side.

A `chain-<name>` hop may leave the machine, and provenance is why that is
allowed at all: a hop that cannot say which engine answered is not
auditable, and an unauditable egress is not one this design accepts.

## Transport

Loopback TCP on **`29200`**, bound on both loopback families — local-only,
no authentication, no tenancy.

`29200` because it is **unassigned and stays that way**. IANA's registry
lists 29170–29998 with no service in it; it is below the ephemeral floor
(`ip_local_port_range` starts at 32768 on the reference box) so no outbound
connection can have taken it first; it avoids the `188xx` block sagaforge
already reserves; and it dodges the informal squatters nearby — PyTorch
distributed defaults `MASTER_PORT` to 29500 and Gerrit uses 29418, both
plausible on a box that runs ROCm containers.

8080 was the earlier choice, on the argument that it is `llama-server`'s
default and therefore the port a client guesses. That argument did not
survive contact with the cutovers: **every consumer hardcodes the
address anyway**, so guessability paid off exactly once — one line of
paper-trail config that did not need editing — while the cost applied to all
of them permanently. 8080 is also the most commonly occupied dev port on a
workstation, and engined is not always running. With engined down and
anything else on 8080, five consumers deliver document text, conversation
turns and `workdir` paths naming private repositories to whatever holds the
port, and get back a 404 page they report as a parse error. An unassigned
port turns that silent misdirect into `ECONNREFUSED`.

`listen_port` still overrides it. **The door is the only port engined writes
down for anything it runs.**

The known holder of 8080 on this box is `Rethunk-AI/bakeoff`, which binds it
for `llama-swap`. That is the misdirect this port choice avoids, arriving
from the one repository deliberately exempt from this daemon. It measures
engine configurations, so routing it through a broker that owns the args
would measure the broker instead. It builds upstream
`ghcr.io/ggml-org/llama.cpp:server-vulkan` rather than the Strix Halo fork
built here, so its numbers describe a different `llama.cpp` than this one
serves, and it runs under podman, which is not installed here.

## Reload

`SIGHUP` re-reads `config.toml`; in-flight requests finish against the old
engine list, new ones see the new one. A new or changed `[[model]]`,
`[engine.args]`, or a changed spec's `image`/devices/`models_max` does not
reach a *running* container: engined re-renders and reports the new list
immediately, but a resident llama-server reads its presets INI only once, at
its own startup, so the engine keeps serving its old shape until it next
starts — idle-stop, or an explicit `POST /v1/engines/:id/start`.

## Deliberately not built

No install, build or update endpoint for *engines* and no stepper UI —
`docker build` by hand, and a missing image reports `unavailable` plus the
literal command. engined's own install is a script, never a route: nothing
reachable over HTTP writes to `~/.local/share/engined/`. No
`/v1/complete`, no `/v1/agent`, no `/v1/health` (contract version, parse state
and reachability all live in `GET /v1/engines`, and a `Type=simple` unit needs
no liveness probe), no `stop` route (idle-stop covers the resting state), and no
`GET /v1/runs/:id` — that was a file read on a client-supplied id with no named
consumer, and `journalctl --user -u engined` is the whole feature.

No `engine` CLI until someone types the same `curl` twice. No capability matrix,
image-sampling defaults, or GPU-wide resource-group mutex. Two locks in scope:
the per-engine **start lock**, and the per-role **lease**. Occupancy is
per-role residency plus explicit same-role unload, not a GPU-wide semaphore.
No multi-machine, auth, tenancy or web UI — the operator surface is
`GET /v1/engines`. No stub adapter.

**No proxy for Comfy, on purpose.** It is explicitly not the collision this
project exists to end — it already loads on demand and unloads after its
own jobs. engined manages only its container lifecycle; a consumer reaches
a started job at its `private_url` directly.

Add any of these when a second consumer, modality or person makes the case.

## Container images (this box: AMD Strix Halo / gfx1151, ROCm 7.2+)

Own Dockerfile per engine, under `engines/<id>/` — no gfx1151-validated pre-built image exists
for any of them. All are two-stage builds: build tools (compilers, venv creation, git) never
reach the runtime image.

**llama.cpp** (`engines/local-llama/Dockerfile`, image `engined-llama-cpp:local`) builds
`llama-server` from [Nathanw1014/llama.cpp](https://github.com/Nathanw1014/llama.cpp)'s
`strix-halo-vulkan` branch (fork of upstream llama.cpp, MIT) — Strix-Halo Vulkan performance
work not yet upstream. Chosen over a same-generation ROCm build after benchmarking both on a
realistic long-context prompt: ties ROCm's prefill throughput while keeping Vulkan's ~14% decode
edge — best combination across 6 candidate images. Only `/dev/dri` needed (no `/dev/kfd`),
native gfx1151 — no ROCm GFX-version override env var. Image: ~938MB.

**ComfyUI** (`engines/comfy/Dockerfile`) bases on `rocm/dev-ubuntu-24.04:7.2.4` (minimal
ROCm/HIP runtime, not `rocm/pytorch` or the `-complete` tag) plus the official PyTorch ROCm
wheels (`--index-url https://download.pytorch.org/whl/rocm7.2`), which are self-contained and
would otherwise duplicate a fuller base's own ROCm math libraries. gfx1151-native — no ROCm
GFX-version override env var. Built and smoke-tested on this box — GPU correctly detected as
`Radeon 8060S Graphics : native`, ROCm 7.2. Image: ~28.9GB (down from 41.1GB using
`rocm/pytorch` as base directly).

**Chatterbox** (`engines/chatterbox/Dockerfile`) follows the same base pattern as ComfyUI.
Installs `chatterbox-tts` (devnen's `chatterbox-v2` fork, which carries gfx1151 dtype fixes over
upstream resemble-ai/chatterbox) with `--no-deps`, then its real runtime dependencies at
versions that actually work on Python 3.12/torch 2.13 — its own `pyproject.toml` pins
`numpy<1.26` (no Python 3.12 wheel exists at all) and `torch==2.5.1`, neither usable here.
`app.py` is the HTTP surface: `POST /v1/tts` → `{audio: base64 WAV, alignment}`. Detects the GPU
(`Radeon 8060S Graphics`) and synthesizes real narration end-to-end over `/v1/tts`. Image:
~29GB.

**Kokoro** (`engines/kokoro/Dockerfile`, CPU) uses a `python:3.12-slim` base with no GPU device
flags — torch installs first from the CPU wheel index (`pytorch.org/whl/cpu`), before
`requirements.txt`, so pip resolves Kokoro's own torch dependency against it instead of pulling
PyPI's CUDA-linked default. Kokoro-82M synthesizes faster than realtime on CPU — the point: it
never queues behind ComfyUI/llama.cpp for the box's single GPU. Image: ~2.8GB (down from 9.33GB
before the CPU-wheel-first fix). Weights are baked at build time
(`KPipeline(lang_code="a")` in the builder stage), the same no-runtime-download posture as
Chatterbox. Fixed voice packs only (no cloning).

## Vision fidelity (local-llama, Vulkan)

Two upstream Vulkan defects affect the vision role. One crashes llama-server and has a
workaround engined already applies (`no-mmproj-offload`, see `engines/local-llama/spec.toml`).

The other has none: **a vision request can return a confident, plausible, wrong description of
the image, with nothing in the response to signal it.** It did not reproduce across three live
checks, which is three data points and not a fix — nothing in this repo can detect a recurrence,
because a wrong description is indistinguishable from a right one without ground truth.

If you are wiring a consumer to the vision role, check output fidelity against an image whose
content you already know, and re-check it when the image, the GGUF or the mmproj build changes.
Treat vision as unproven until you have done that for your own consumer; the other roles carry
no equivalent caveat.

## Speculative decoding (local-llama)

`engines/local-llama/spec.toml` passes `--spec-type draft-mtp` for any catalog model marked
`mtp` — the head lives inside the GGUF, and llama.cpp only infers a speculative type from a
*separate* draft model, so it has to be named. Naming it on a headless GGUF is fatal (`model
doesn't contain MTP layers`, exit 1), which is why the flags follow the model rather than being
unconditional.

Two independent measurements on this box justify the choice, over Ornith-1.5-35B-A3B MTPv2,
Vulkan/RADV, `q8_0` K/V:

Sweeping `spec-draft-p-min` at `--ctx-size 32768`, 1200 tokens generated ("prose" is an
8416-token prompt, "structured" a JSON array over the same context):

| config | prose tok/s | structured tok/s |
| --- | --- | --- |
| no speculation | 54.05 | 53.13 |
| `draft-mtp`, `p-min 0.95` | 47.75 | 60.91 |
| `draft-mtp`, `p-min 0.75` | 50.99 | 66.12 |
| `draft-mtp`, `p-min 0.10` | **54.70** | **66.99** |

The payoff tracks draft acceptance, which is a property of the output shape: 83% on prose
against 98% on structured output. A high `p-min` is counterproductive because the draft is
computed before the gate reads it — the threshold only decides whether the work already done
gets used. Hence `0.1`, where prose is break-even and structured output gains ~26%. Prompt
processing is unaffected either way (~1000 tok/s on the 8.4k prompt) — speculation is a
decode-side mechanism.

Sweeping `spec-draft-n-max` at `p-min 0.1`, warm, same prompt: n=1 gives 62.94 t/s decode at 73%
draft acceptance, n=3 is 62.75 at 54%, n=12 collapses to 24.85 at 19% and n=16 to 22.30 — decode
degrades monotonically as acceptance falls, so raising `n-max` past 1 is a loss here. Those are
32-token BURST figures; acceptance decays with generation length and decode tracks it almost
exactly, so the same build measures 62.6 t/s over 32 generated tokens (93% acceptance), 54.3
over 128 (73%), and 54.0 over 512 (71%). Quote ~54 t/s for anything that generates a paragraph,
and never compare a decode number taken over 32 tokens with one taken over 512. `config.toml`
therefore ships `spec-draft-n-max = 1`.

Do not re-derive any of this by reasoning from file size. Decode on a sparse MoE tracks the
*active* bytes per token, not the size of the GGUF: switching from a 36.9 GB Q8_0 file to this
24.85 GB one is a 33% smaller file but only ~11% faster (49.60 → 55.40 tok/s, 400 tokens, short
prompt), because only 8 of 256 experts are read per token and this tier's active bpw barely
moves.
