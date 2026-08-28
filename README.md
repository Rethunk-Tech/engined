<h1 align="center">engined</h1>

<div align="center">

One local engine broker for the whole workstation.

</div>

---

A `systemd --user` daemon that owns every inference engine on this box and
serves them behind one OpenAI-shaped door on loopback. Chat, embeddings,
speech and transcription all arrive at the same port; engined decides which
engine answers, starts its container on demand, keeps one model resident per
role, and stops it again when it goes idle. Consumers hold no provider keys,
supervise no containers, and download no weights.

## Install

```sh
bash scripts/install.sh
```

Builds a single-file bundle, syncs `engines/` into `~/.local/share/engined/`
(`$XDG_DATA_HOME/engined/` when that is set),
renders the `systemd --user` unit and restarts it. Running it again is the
update — there is no other install or update path, and nothing reachable over
HTTP writes to the install directory.

Never run it under `sudo`: root-owned outputs break every later user-level
build.

## Configure

```sh
cp config.example.toml ~/.config/engined/config.toml
$EDITOR ~/.config/engined/config.toml
```

`config.example.toml` is a worked, committed configuration covering every
engine this repo ships a spec for. `src/config-example.test.ts` parses it
with the real loader on every run, so it cannot go stale.

Edit it for your machine: which engines you have images for, which GGUFs you
downloaded, which `claude_version` you have proved. A config naming a file
that is not on disk, or an engine whose spec directory is not installed,
fails loudly at parse rather than starting broken. Every first-class key is
one of a closed set, so a typo'd key is a parse error by design rather than a
silent no-op.

Secrets never live in the config. A remote engine names a keyring entry and
engined resolves it per request, so a `--user` unit that boots before the
keyring unlocks recovers at your next sign-in without a reload:

```sh
secret-tool store --label='elevenlabs-api' service elevenlabs-api username scribe
```

## The HTTP surface

Loopback TCP on **`29200`**, both loopback families. No authentication, no
tenancy, no TLS — it is local-only. `listen_port` overrides the port.

| Route | Method | Answered by |
| --- | --- | --- |
| `/v1/chat/completions` | POST | `openai-http`, `agentic-cli` |
| `/v1/embeddings` | POST | `openai-http` |
| `/v1/audio/speech` | POST | `tts` |
| `/v1/audio/transcriptions` | POST | `stt` |
| `/v1/models` | GET | every dispatchable `model` string |
| `/v1/engines` | GET | engine list, state, and the fix for anything unavailable |
| `/v1/engines/:id/start` | POST | warms one engine, returns its `private_url` |

`/tokenize`, `/detokenize`, `/apply-template`, `/slots`, `/slots/:id`,
`/models/load` and `/models/unload` proxy through to the one local llama
engine, with the resident chat model injected where the body omits one.

### Choosing a model

The OpenAI `model` field accepts four spellings:

| Form | Example | Notes |
| --- | --- | --- |
| bare id or alias | `ornith` | only when exactly one engine serves it; two or more is a 400 listing the qualified forms |
| engine id | `chatterbox` | for kinds that take no separate model (`agentic-cli`, `tts`, `stt`) |
| chain name | `chain-private` | an ordered fallback list |
| qualified | `@/local-llama/ornith` | canonical, and the only form a chain hop may use |

The `@/` prefix exists because the obvious spelling collides with reality: a
Hugging Face id is already `org/model`, and a GGUF filename is the same
shape, so a bare `engine/model` cannot be told apart from a repo name. `@/`
is what makes the namespace unambiguous without banning slashes from either
side.

A chain is an ordered list a consumer names instead of one model. It advances
on a 5xx or an empty body and stops on a 4xx — a caller's own bad request is
not something a second engine can fix. `chain-private` is one hop on purpose:
it is the name a consumer points at to say *this prompt does not leave the
box*, and keeping it a chain means adding a second local engine later is a
config edit rather than a consumer change.

A chain hop may leave the machine, and provenance is why that is allowed at
all. A hop that cannot say which engine answered is not auditable, and an
unauditable egress is not one this design accepts.

## Operating it

```sh
curl -s localhost:29200/v1/engines | jq     # state, and the fix for anything unavailable
journalctl --user -u engined -f             # one JSON line per call
systemctl --user kill -s HUP engined        # re-read config.toml
```

`GET /v1/engines` is the whole operator surface. An engine that cannot run
reports `unavailable` with the literal command that fixes it — `docker
pull …`, `docker build …`, or the `secret-tool store` line for a missing key.
A running engine also reports `active_leases`, the requests holding it open
right now, which is how a caller waiting on an engine that serializes
internally becomes visible at all.

Every call writes one structured line to journald naming the chain, the model
requested, each attempt with its duration, and which engine answered. A
streamed call's line is deferred until the stream ends, so a mid-body
disconnect lands as that attempt's failure rather than vanishing.

**Idle-stop.** An engine stops once nothing has held it for
`idle_stop_seconds`. Leases are counted, so the countdown cannot fire
mid-request, and it is armed on start as well as on release — an engine
warmed by `POST /v1/engines/:id/start` and never dispatched to still stops on
its own. Measured on this box: a resident 35B GGUF returns ~27 GiB to the
shared pool when its engine idles out.

**Reload.** `SIGHUP` re-reads `config.toml`; in-flight requests finish
against the old engine list and new ones see the new one. A new or changed
`[[model]]`, `[engine.args]`, or a changed spec's `image`/devices/`models_max`
does not reach a *running* container: llama-server reads its presets INI
once, at its own startup, so an engine keeps serving its old shape until it
next starts — idle-stop, or an explicit start.

## What engined owns

engined owns the engine list and its shape, secret resolution, aliases, chain
ordering and fallback, OpenAI `model` dispatch, llama.cpp occupancy,
container lifecycle for every managed engine, the spec directory that
describes each one, invocation of every kind including `agentic-cli` and the
read-only launch arguments that make it safe, and provenance.

Consumers own prompts, context assembly, output parsing, Comfy graphs, which
chain or model string to send, and writing to disk whatever they keep from
what an agent returned.

**engined knows nothing about the task.** If changing a feature's prompt
would require an engined change, the line has been drawn wrong.

Nothing else on this box starts an inference container: under load, `docker
ps` shows `engined-*` only. `majordomo`, `paper-trail`, `sagaforge-ts`,
`bastion-client-discord`, `citadel` and `prepaudit` all reach this door for
chat, embeddings, vision, speech and transcription, and none of them
supervises a server, downloads weights, or holds a provider key.

`Rethunk-AI/bakeoff` is the one deliberate exception. It is a benchmark
harness whose whole purpose is measuring engine *configurations*, and routing
it through a broker that owns the args would measure the broker instead. It
never runs concurrently with production inference.

## Agentic engines: integrity, not confidentiality

Agentic CLIs are an engine *kind*, not a separate API. They are launched with
writing structurally disabled, so they read a repository and return text like
any other completion, and engined never writes to a caller's worktree.

The guarantee is **integrity, not confidentiality.** `workdir` says where an
agent begins, not what it may read. Measured: under the full read-only floor,
an agent asked for `/etc/hostname` returns it, with no permission denial.

What an agentic call cannot do is *change* the caller's tree. What it
emphatically can do is read anything this uid can open — every private key,
the `gh` identity, the credentials of the CLI being run — and send it
wherever a chain ends. A workdir allowlist bounds nothing meaningful, since
the fleet's source lives inside any plausible root. A local process already
reads those files directly; what engined adds is convenience and an egress
path.

**Adding a second, less-trusted caller is the moment this stops being
acceptable.**

## Deliberately not built

No install, build or update endpoint for *engines* and no stepper UI —
`docker build` by hand, and a missing image reports `unavailable` plus the
literal command. No `/v1/complete`, no `/v1/agent`, no `/v1/health` (contract
version, parse state and reachability all live in `GET /v1/engines`, and a
`Type=simple` unit needs no liveness probe), no `stop` route (idle-stop
covers the resting state), and no `GET /v1/runs/:id` — a file read on a
client-supplied id with no named consumer, where `journalctl --user -u
engined` is the whole feature.

No `engine` CLI until someone types the same `curl` twice. No capability
matrix, image-sampling defaults, or GPU-wide resource-group mutex. Two locks
in scope: the per-engine **start lock** and the per-role **lease**. Occupancy
is per-role residency plus explicit same-role unload, not a GPU-wide
semaphore. No multi-machine, auth, tenancy or web UI. No stub adapter.

**No proxy for Comfy, on purpose.** It is explicitly not the collision this
project exists to end — it already loads on demand and unloads after its own
jobs. engined manages only its container lifecycle; a consumer reaches a
started job at its `private_url` directly.

Add any of these when a second consumer, modality or person makes the case.

---

## Reference

### Why 29200

Unassigned, and stays that way. IANA lists 29170–29998 with no service in it;
it sits below the ephemeral floor (`ip_local_port_range` starts at 32768
here) so no outbound connection can take it first; it avoids the `188xx`
block sagaforge reserves and the informal squatters nearby — PyTorch
distributed defaults `MASTER_PORT` to 29500, Gerrit uses 29418.

The alternative was 8080, `llama-server`'s own default. Every consumer
hardcodes the address anyway, so guessability buys one line of config while
the cost is permanent: 8080 is the most commonly occupied dev port on a
workstation, and engined is not always running. With engined down and
anything else on 8080, consumers deliver document text, conversation turns
and `workdir` paths naming private repositories to whatever holds the port,
and get back a 404 page they report as a parse error. An unassigned port
turns that silent misdirect into `ECONNREFUSED`. The known holder of 8080
here is `bakeoff`, binding it for `llama-swap`.

**The door is the only port engined writes down for anything it runs.**

### Container images (this box: AMD Strix Halo / gfx1151, ROCm 7.2+)

Own Dockerfile per engine under `engines/<id>/` — no gfx1151-validated
pre-built image exists for any of them. All are two-stage: build tools
(compilers, venv creation, git) never reach the runtime image.

**llama.cpp** (`engines/local-llama/`, `engined-llama-cpp:local`) builds
`llama-server` from [Nathanw1014/llama.cpp](https://github.com/Nathanw1014/llama.cpp)'s
`strix-halo-vulkan` branch (fork of upstream, MIT) — Strix-Halo Vulkan work
not yet upstream. Chosen over a same-generation ROCm build after benchmarking
both on a realistic long-context prompt: ties ROCm's prefill throughput while
keeping Vulkan's ~14% decode edge, best of 6 candidate images. Only
`/dev/dri` needed (no `/dev/kfd`), native gfx1151 — no ROCm GFX-version
override. ~938 MB.

**ComfyUI** (`engines/comfy/`) bases on `rocm/dev-ubuntu-24.04:7.2.4`
(minimal ROCm/HIP runtime, not `rocm/pytorch` or `-complete`) plus the
official PyTorch ROCm wheels, which are self-contained and would otherwise
duplicate a fuller base's own ROCm math libraries. GPU detected as `Radeon
8060S Graphics : native`. ~28.9 GB, down from 41.1 GB on `rocm/pytorch`.

**Chatterbox** (`engines/chatterbox/`) follows ComfyUI's base pattern.
Installs `chatterbox-tts` (devnen's `chatterbox-v2` fork, which carries
gfx1151 dtype fixes) with `--no-deps`, then its real runtime dependencies at
versions that work on Python 3.12 / torch 2.13 — its own `pyproject.toml`
pins `numpy<1.26` (no Python 3.12 wheel exists at all) and `torch==2.5.1`,
neither usable here. ~29 GB.

**Kokoro** (`engines/kokoro/`, CPU) uses `python:3.12-slim` with no GPU device
flags — torch installs first from the CPU wheel index, before
`requirements.txt`, so pip resolves Kokoro's own torch dependency against it
instead of pulling PyPI's CUDA-linked default. Kokoro-82M synthesizes faster
than realtime on CPU, which is the point: it never queues behind
ComfyUI/llama.cpp for the box's single GPU. ~2.8 GB, down from 9.33 GB before
the CPU-wheel-first fix. Weights baked at build time. Fixed voice packs only,
no cloning.

### Vision fidelity (local-llama, Vulkan)

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

### Speculative decoding (local-llama)

`engines/local-llama/spec.toml` passes `--spec-type draft-mtp` for any
catalog model marked `mtp` — the head lives inside the GGUF, and llama.cpp
only infers a speculative type from a *separate* draft model, so it has to be
named. Naming it on a headless GGUF is fatal (`model doesn't contain MTP
layers`, exit 1), which is why the flags follow the model rather than being
unconditional.

Two measurements on this box justify the settings, over Ornith-1.5-35B-A3B
MTPv2, Vulkan/RADV, `q8_0` K/V.

Sweeping `spec-draft-p-min` at `--ctx-size 32768`, 1200 tokens generated
("prose" is an 8416-token prompt, "structured" a JSON array over the same
context):

| config | prose tok/s | structured tok/s |
| --- | --- | --- |
| no speculation | 54.05 | 53.13 |
| `draft-mtp`, `p-min 0.95` | 47.75 | 60.91 |
| `draft-mtp`, `p-min 0.75` | 50.99 | 66.12 |
| `draft-mtp`, `p-min 0.10` | **54.70** | **66.99** |

The payoff tracks draft acceptance, a property of the output shape: 83% on
prose against 98% on structured output. A high `p-min` is counterproductive
because the draft is computed before the gate reads it — the threshold only
decides whether work already done gets used. Hence `0.1`, where prose is
break-even and structured output gains ~26%. Prompt processing is unaffected
either way (~1000 tok/s on the 8.4k prompt): speculation is a decode-side
mechanism.

Sweeping `spec-draft-n-max` at `p-min 0.1`, warm, same prompt: n=1 gives
62.94 t/s decode at 73% draft acceptance, n=3 is 62.75 at 54%, n=12 collapses
to 24.85 at 19% and n=16 to 22.30 — decode degrades monotonically as
acceptance falls, so raising `n-max` past 1 is a loss here. The config ships
`spec-draft-n-max = 1`.

Those are 32-token **burst** figures. Acceptance decays with generation
length and decode tracks it almost exactly: the same build measures 62.6 t/s
over 32 generated tokens (93% acceptance), 54.3 over 128 (73%), and 54.0 over
512 (71%). Quote ~54 t/s for anything that generates a paragraph, and never
compare a decode number taken over 32 tokens with one taken over 512.

Do not re-derive any of this by reasoning from file size. Decode on a sparse
MoE tracks the *active* bytes per token, not the size of the GGUF: switching
from a 36.9 GB Q8_0 file to this 24.85 GB one is a 33% smaller file but only
~11% faster (49.60 → 55.40 tok/s, 400 tokens, short prompt), because only 8
of 256 experts are read per token and this tier's active bpw barely moves.

## Development

`AGENTS.md` covers the test tiers, the config/spec split and the conventions
this repo is built against. `TODO.md` carries genuine outstanding work only,
and is currently empty.
