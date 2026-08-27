# engined

`TODO.md` is the authoritative artifact and
is organised **per feature** — each entry carrying its own description, `Traps`
and `Acceptance`. `PHASES.md` holds only the order to build them in and
references those entries without restating them. `docs/migrations/` holds one
cutover guide per consumer. `README.md` says only what the service is.

The implementation lives in `src/`, Bun and TypeScript, and is built against
those entries rather than against itself: an acceptance criterion is the test,
and a `Traps` bullet is a behaviour some engine actually has.

## How the work is ordered

`PHASES.md` orders **phase completion**, not the moment each file is written. A
module whose dependencies are already met may be built ahead of its phase — the
phases still close in order, and a phase is done only when every acceptance
criterion of every entry it names passes. The alternative idles most of the
build, because the tail of a phase is usually serial.

Each phase carries a why-this-slice-here argument, not just a delivery list:

1. **Config, routes, status.** The slice that serves no completion. Everything
   after it is an engine plugged into machinery that already exists, which is
   why the generic lifecycle lands here rather than being rebuilt per engine in
   phases 2, 6 and 7. `GET /v1/engines` ships here for the same reason: it is
   the only operator surface, so a phase that could not report its own state
   would have to be debugged blind.
2. **The llama.cpp router.** The founding problem is two llama.cpp processes,
   so the engine that ends it comes first among engines. It is also the
   hardest one — router mode, per-role occupancy, the presets INI, swap cost —
   and everything learned here shapes how the rest are specified. The extras
   proxy rides along because it is the same upstream and the same injection
   rule, and splitting it would mean touching this engine twice.
3. **Chains, fallback, egress.** Needs two engines to be meaningful, and phase
   2 only supplies one — so this phase's fault injection uses a deliberately
   broken hop rather than waiting for phase 4. Provenance lands with it
   because a chain that cannot say which engine answered is not auditable,
   and auditability is the reason chains are allowed to egress at all.
4. **Remote engines and secrets.** The first phase where a prompt can leave
   the machine, which is why it comes after the rules that govern leaving are
   already built and tested.
5. **The agentic kind.** Last of the text engines because it is the one whose
   safety is a property of how it is launched rather than of what it is. It
   needs the config shape, the spec dialect, provenance and the sandbox all
   finished before its guarantee means anything — and it is the phase
   `project-register` waits on.
6. **Audio.** After the text path is settled, because nothing in the audio
   doors is novel once the lifecycle and the spec dialect exist. TTS before
   STT within the phase: chatterbox has a runnable image and whisper needs
   both an image and a model artifact that are not on this box.
7. **Comfy lifecycle.** Deliberately near the end. Comfy is explicitly *not*
   the collision this project exists to end — it already loads on demand and
   unloads after jobs — so it moves last among managed engines, and only for
   the lifecycle, never a proxy.
8. **Embeddings.** Last because it is the only engine whose model choice has
   a consumer-visible consequence beyond this repository, and because it
   co-resides on the phase-2 llama-server rather than adding an engine of its
   own.

## Testing

Three tiers, and the split is load-bearing rather than tidy.

`src/*.test.ts` is the tier that runs in CI: parse, dispatch, chain-advance and
provenance against a fake upstream `Bun.serve`, needing nothing installed.

`test/local/*.test.ts` needs images, a GPU or `claude` auth, and is guarded by
`ENGINED_LOCAL=1`. It never runs in CI. **Only the llama router runs it against
a real container, and serially** — this workstation shares one GPU with other
work, so a second engine instance is never started to satisfy a test.

There are no mocks and no stub adapter, for the same reason the design refuses
one at runtime: every trap here was tool behaviour rather than logic, and a fake
reproduces the logic and none of the behaviour. Where a dependency must be
substituted it is injected as a function with a real default, and the fixtures
are recorded output from the real tool.

**Shipped images are migrated, never invented.** The fleet already carries
Dockerfiles and run specs for comfy, chatterbox, kokoro and whisper; they are
adapted here for this GPU — gfx1151, ROCm or Vulkan, never CUDA.

## The config example

`config.example.toml` is the only committed, always-parsing reference for how
to configure this daemon — one entry per shipped engine, kept honest by
`src/config-example.test.ts` calling the real `loadConfig()` against it.
Changing `src/config.ts`'s key set, an engine's `spec.toml` (a new required
placeholder, a renamed one), or where models live on disk means updating
`config.example.toml` in the same change, not after — the test fails the
whole suite the moment the two drift, which is the point.

## Config vs. spec, and why the split is not tidiness

An engine's *shape* is not configuration. Every engine engined **launches** —
a container, or `claude` — is a directory shipped with engined at
`engines/<id>/`, holding a `spec.toml`, the Dockerfile when the image is
built locally, and any file the container needs mounted. `config.toml` names
the engine and supplies only what varies by install. An engine that is
merely a remote address has nothing to launch and stays wholly in
`config.toml`: `base_url`, `secret`, `egress`.

Three shipped specs carry a detail that fails *silently* when it is dropped —
Comfy's `--preview-method latent2rgb`, without which the relay's preview
frames never arrive; kokoro's entrypoint override, without which its image
floods the log at debug level; whisper's `--inference-path`, which is the
only reason it is OpenAI-shaped — and the agentic launch flags are the
read-only guarantee itself. Those belong in a file that ships and diffs, not
one an operator edits. `TODO.md`'s Engine specs entry says what a spec itself
describes.

**Everything tunable is config, and it goes as deep as the model.** So
`[engine.args]` carries an engine's process flags and `[model.args]` carries
a model's, rendered into that model's section of the presets INI. Only keys
engined's own logic reads stay first-class, and that list is closed —
`src/config.ts`'s `ENGINE_KEYS` is what enforces it: `id`, `egress`,
`spec_dir`, `models_dir`, `models_max`, `idle_stop_seconds`,
`ready_timeout_s`, `claude_version`, and — for an engine that is only a
remote address — `kind`, `base_url`, `secret`. Everything else passes
through untouched, and a first-class key not on that list is a bug in the
list rather than a passthrough. `{claude_version}` is substituted from that
key; it is not an args passthrough and it is never `@latest`. Precedence is
one line: **model args beat engine args, config args beat spec args, and the
floor beats everything.**

**Which keys are required depends on what the entry describes.**

| Entry | Required | Absent by construction |
| ------ | ------ | ------ |
| `[[model]]` on a llama engine | `id`, `engine`, `filename`, `role` | — |
| `[[model]]` on an agentic engine | `id`, `engine` | `filename`, `role` |
| `[[engine]]`, every kind | `id`, `egress` | — |
| `[[engine]]`, a remote address only | `id`, `egress`, `base_url`, `secret` | `spec_dir`, `models_dir`, `models_max` |

`filename` and `role` are absent from an agentic model because both exist to
account for occupancy and an agentic attempt is never resident — the
reasoning that makes them fatal on a llama model is what makes them
inapplicable here. `egress` has no such exemption: every engine of every
kind declares it, because it is what `local_only` reads.

## The Origin/Host check

**The Origin check guards the door and not the containers behind it.** Managed
engines publish on loopback with no middleware in front, and a page cannot
read their responses but does not need to — llama takes `/models/load` and
Comfy takes a workflow graph, and a side effect is enough. Ephemeral ports
are not a control: a page scans loopback faster than a human notices. This is
accepted and named rather than implied — docker-internal isolation was
declined. Closing it would mean putting managed containers on a docker
network and reaching them from engined alone, which the port read-back
already makes possible, since no consumer holds a stable address it did not
ask for.

**The browser is a caller too.** Loopback is reachable from any page the
operator has open, and a cross-origin `POST` carrying `Content-Type:
text/plain` is not preflighted while `req.json()` parses it anyway — so a
page can name a `workdir` and a remote-bearing chain and ship repository
content off-machine without ever reading the response. So every request is
checked for origin first, on every endpoint including reads: a foreign
`Origin`, an `Origin: null` (refused rather than treated as absent), or a
`Host` outside `{127.0.0.1, localhost, [::1]}` at the configured port is
refused. One middleware. A request carrying no `Origin` is served normally,
which covers every CLI and server consumer. **One consumer is a browser**:
sagaforge's `/settings/engines` becomes a read-mostly client of
`GET /v1/engines`, and a page served from sagaforge's own origin sends one.
It is refused. That page reaches engined through the sagaforge daemon it is
already talking to, and the alternative — allowlisting a consumer's origin —
would reopen the hole this check exists to close. This is not
authentication; it is what keeps the accepted risk below reachable only by a
local process, which is the case that argument covers.

## Why cursor-agent was not shipped

Only `claude` ships. `cursor-agent`'s read-only mode could not be
demonstrated: it refuses to run at all in an untrusted directory, and with
`--plan --trust` it wrote nothing but produced no output either, so "the mode
held" and "it never ran" are indistinguishable. A kind whose read-only
enforcement has not been *shown* is not shipped.

## Before committing

`python3 scripts/doc-sweep.py TODO.md PHASES.md README.md AGENTS.md
docs/migrations/*.md`, or `gate run docs`. It catches edit damage a reader misses: a sentence that lost its
tail to a partial revision, an unclosed fence, a term declared absent in one
section and still required by an acceptance criterion in another.

## Cutting a consumer over

Nothing is committed to a consumer's repository until `engined` carries enough
feature to replace what that consumer runs today, and the operator says to turn
it on. Reading a sibling project to migrate a definition **into** here is
ordinary work; landing a cutover **there** is not, because a consumer pointed at
a daemon that cannot yet serve it is a broken consumer.

`Rethunk-Tech/project-register` is off limits entirely — someone else is working
in it.

The two consumers that each start their own `llama.cpp` today, `sagaforge-ts`
and `paper-trail`, are the reason this service exists. Neither may be cut over
while it still starts one: ending the duplicate ownership is the point, and a
consumer that keeps its own runner has not been cut over, only pointed twice.

## Editing the migration guides

Each guide describes a real repository that is on disk. Anchors are
`path:symbol` with a line number as a hint — **grep the symbol**, line numbers
drift. A claim about a consumer's behaviour is checkable against that consumer's
source, so check it rather than reasoning from the guide.

## Two rules that are easy to get wrong

**No port is written down for anything engined starts.** The container side comes
from the image's `EXPOSE`, the host side from Docker. The door is the sole
exception, plus a remote upstream's `base_url`.

**The agentic guarantee is integrity, not confidentiality.** An agentic call
cannot change a caller's worktree. It can read anything this uid can open. Any
wording implying `workdir` bounds reads is wrong.
