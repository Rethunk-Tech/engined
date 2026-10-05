# engined

Contributor map. `README.md` orients; `HUMANS.md` is the runbook. This file
covers test tiers, the config/spec split, and invariants.

Outstanding work is tracked in the task list, not in a file. Only one thing
is worth writing down here: an acceptance criterion nobody has actually
proven stays recorded even when the feature looks done, because deleting it
erases the only record that it is unproven.

This one checkout is often worked by several sessions at once. A commit no worker of yours claims, a gate failure on files nobody in your run touched, or a finding already fixed is usually a sibling: date it (`git log -S<symbol>`) before "fixing" it, since every session commits under the same author, and prefer serial work to fan-out while siblings are active.

Implementation: `src/`, Bun and TypeScript. Acceptance criteria and engine
traps live beside the code they govern.

## Testing

Three tiers:

- `src/*.test.ts` — CI: parse, dispatch, chain-advance, provenance against a
  fake upstream. Nothing installed.
- `test/local/*.test.ts` — `ENGINED_LOCAL=1`, serial against real containers.
  Never in CI. **The constraint is free memory, not a running container.**
  `requireMemoryFor` (`test/local/exclusive.ts`) reads `MemAvailable` and
  refuses only when the pool cannot hold what the suite is about to load. A
  running container is not a resident model: llama-server idles with nothing
  loaded until a request arrives, so `docker ps` routinely shows an engine
  holding a few hundred MiB and no weights. Only comfy (~42 GiB) and llama
  (~30 GiB with its 262k-token KV cache) are large enough to contend, and only
  the suites loading them check at all — every TTS and STT engine is under
  ~3.5 GiB and several are resident together without contention, so the audio
  suite needs no check. Stopping the unit is one way to free the pool, never
  a precondition. Run as `bun run test:local` (not by pointing `bun` at the
  directory).
- No mocks — traps are tool behaviour; substitutes are injected functions with
  real defaults and recorded output.

Guards with failing tests: one container start under concurrent load; one llama
owner under cross-role load; port-in-use exits 78; Comfy diffusion through a
real checkpoint when weights are present.

Two criteria that were recorded here are now proven and no longer need a note:
a rerank request through the real door (`engined-probe` reports `ok
@/llama/rerank: ranked the answering document first`) and an image edit
through a real comfy (a 512x512 render fed back through
`/openai/v1/images/edits` returned a derived image, verified by eye).

**Measured, and poor: translation quality on large-v3-turbo-q8_0.** The verb
itself is proven end to end. Speech synthesized through
`@/chatterbox-multi/local` saying "El gato negro duerme sobre la mesa de
madera en la cocina" came back from `/openai/v1/audio/transcriptions` on
`@/whisper/large-v3-turbo` character for character, and from
`/openai/v1/audio/translations` on the same route as English -- while
`@/whisper/medium.en` refused that verb with a 400. Plumbing, refusal and
round trip all hold.

The English was wrong: "The black man sleeps on the bed in the kitchen."
`gato` became "man" and `mesa de madera` became "bed". That is not an audio
problem and the transcription is what proves it -- the same recording was
heard perfectly, so the loss is in the model's translation head rather than in
anything this door does. Whether q8_0 costs translation more than it costs
transcription is untested and is the first thing to try.

So: wire a consumer to this verb only after checking it against speech you
understand, and do not read a fluent English sentence as a correct one. The
probe cannot catch this -- it is the same confident-wrong-answer shape as the
vision defect, and there is no ground truth for it in code.

Agentic cost is read from each CLI's own envelope, and each shape was
captured from a real run rather than guessed -- claude's `total_cost_usd`,
opencode's `part.cost`, cursor's camelCase tokens. A new agent means capturing
its envelope the same way; `envelopeUsage`/`opencodeUsage` in `src/agents.ts`
name what is read.

Shipped images are migrated from the fleet (gfx1151, ROCm/Vulkan, never CUDA),
never invented.

## Config vs spec

`config.example.toml` is the committed reference — kept honest by
`src/config-example.test.ts` calling `loadConfig()`. Update it in the same
change as `src/config.ts` or any `spec.toml` drift.

An engine engined **launches** is `engines/<id>/` (`spec.toml`, Dockerfile,
mounted files). `config.toml` names it and supplies install-specific values.
An engine has no address of its own — a remote-address engine names its
`[[upstream]]` instead, which carries `base_url`, `secret`, `egress`.

`chatterbox-en` and `chatterbox-multi` stay separate images by operator
decision: one image failing to build never blocks the other's launch. They
build from one wrapper, `engines/chatterbox-shared/chatterbox_app.py`, and one
`engines/chatterbox-shared/Dockerfile`; each `app.py` supplies only its own
checkpoint and `generate()` call, and each `build-args` only the checkpoint to
bake and the port to serve.

`whisper` also runs a wrapper, `engines/whisper/whisper_app.py`, but it is
bind-mounted through `{spec_dir}` rather than baked: it is PID 1, proxies the
OpenAI verb to whisper-server on loopback, and adds the streaming route
whisper-server has no handler for. Editing it needs a container restart, never
an image rebuild.

A build's context is the spec's own directory, so a file two images share is
in neither context. Three files in a spec dir declare what its build needs, all
read generically by `src/dockerArgs.ts` and appended to the `docker build` a
missing image names as its fix -- which stays one runnable command:

- `build-contexts`: `name=path` lines, path relative to the spec dir, emitted
  as `--build-context` and read by the Dockerfile with `COPY --from=<name>`.
- `build-args`: `name=value` lines, emitted as `--build-arg`, which is how one
  Dockerfile produces two distinct images from two separate builds.
- `dockerfile-path`: the recipe to build, relative to the spec dir, when it is
  not the spec dir's own `Dockerfile`. It is `-f`, read off the filesystem
  rather than out of the context -- a symlink in the spec dir does not work,
  buildkit refuses to follow one out of the context.

Each image still builds from its own context and reads nothing of the other's.

Spec-shipped details that fail silently when dropped (Comfy preview method,
kokoro entrypoint, whisper `--inference-path`, an agent's `agent` id) belong
in spec, not operator config. Tunables go in `[engine.args]` / `[route.args]`;
engined's closed key sets are `ENGINE_KEYS`/`UPSTREAM_KEYS`/`MODEL_KEYS`/
`ROUTE_KEYS`/`CHAIN_KEYS` in `src/configParse.ts`. Precedence: **route beats
engine, config beats spec, floor beats everything.** On remotes,
`[engine.args]` are wire parameters — see `src/upstream.ts`.

`[[model]]` rows are optional capability declarations only; `filename`,
`role` and `keep_resident` live on `[[route]]`, which pairs an engine with an
upstream and, where one applies, a model.

| Entry | Required | Absent by construction |
| ------ | ------ | ------ |
| `[[route]]` on llama | `engine`, `upstream`, `model`, `filename`, `role` | — |
| `[[route]]` on agentic | `engine` | `filename`, `role` |
| `[[engine]]`, every kind | `id` | — |
| `[[upstream]]`, remote address | `id`, `egress`; a missing `base_url` parses and refuses at dispatch | — |

Origin/Host check, browser callers, and why `cursor-agent` ships disabled —
nothing can thread a door URL into its launch:
[docs/security-model.md](docs/security-model.md).

## Invariants

**No port is written down for anything engined starts** except the door and a
remote `base_url`. Host ports come from Docker; container side from `EXPOSE`.

**One comfy prompt is in a container at a time.** `POST /prompt` holds until
the container's queue drains (`src/comfyProxy.ts`), which is the whole reason
`POST /cancel` may send comfy's unscoped `/interrupt`: with nothing queued
behind the running job, an interrupt cannot stop a successor. Removing the gate
silently reopens that race, and the reply a caller gets stops being provable.

**Agentic guarantee is integrity, not confidentiality.** An agentic call cannot
change a worktree; it can read anything this uid can open.

**Where the floor comes from is per-agent** (`src/agents.ts`): argv flags for
claude and cursor, a `bwrap` sandbox for opencode, which has no such flag and whose own
config is overridable from any ancestor of the workdir. An agent declared
`sandbox` never launches without one. Adding an agent means adding its launch,
its stdout parser and the probe that re-proves its floor on every new pin.

**No door logs a prompt.** The provenance line is the only per-call record and
carries no request content; the stderr of a child running a caller's prompt is
dropped, never forwarded. See [docs/security-model.md](docs/security-model.md).

**The unit's read-only sandbox does not survive docker.** `docker run` writes as
root; docker-group access is root-equivalent. A `spec_dir` override is a
privilege decision — spec is trusted code. See `scripts/engined.service.in`.

**An engine improvement reaches every consumer; a consumer's does not.** engined
is a shared door, so a latency or quality floor inside an engine is paid by
every consumer at once -- whichever one happens to measure it first. Weigh
engine-side work against that whole set, not against the one caller that
reported it: a gain too small to matter for a single consumer is worth taking
when all of them bank it. Fix the floor in the engine
rather than working around it in each caller.

Before committing: `gate` (build, typecheck, lint, test, actionlint).
`bun run ci` runs the same four bun tasks through turbo, which keys each
on its own inputs -- a docs-only change replays them from cache.

Do not cut consumers over until engined can replace what they run today.
