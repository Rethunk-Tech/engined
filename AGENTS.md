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
