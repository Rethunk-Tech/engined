# Configuration

`config.toml` lives at `$XDG_CONFIG_HOME/engined/config.toml`
(`~/.config/engined/config.toml` when XDG is unset). `config.example.toml` in
the repo root is a worked, committed reference covering every engine this repo
ships a spec for; `src/config-example.test.ts` parses it with the real loader
on every run, so it cannot go stale.

Every rule here is fatal at parse. A daemon serving a config it cannot fully
trust is worse than one that refuses to start.

## Config versus spec, and why the split is not tidiness

An engine's *shape* is not configuration. Every engine engined launches is a
directory shipped with the repo at `engines/<id>/`, holding a `spec.toml`, the
Dockerfile when the image is built locally, and any file the container needs
mounted. `config.toml` names the engine and supplies only what varies by
install.

An engine that is merely a remote address has nothing to launch and stays
wholly in `config.toml`: `base_url`, `secret`, `egress`.

## The closed key set

Only keys engined's own logic reads stay first-class, and that list is closed —
`src/config.ts`'s `ENGINE_KEYS` enforces it. A typo'd key is a parse error by
design rather than a silent no-op.

| Key | Applies to |
| --- | --- |
| `id`, `egress` | every engine, every kind |
| `spec_dir` | override the shipped spec directory (a privilege decision — see [security-model.md](security-model.md)) |
| `models_dir` | engines with a host model tree |
| `models_max` | llama occupancy floor; fatal below the number of distinct roles configured |
| `idle_stop_seconds` | how long an engine may sit unheld before it stops |
| `ready_timeout_s` | how long a start may take to pass its readiness probe |
| `claude_version` | agentic engines; substituted as `{claude_version}`, never `@latest` |
| `kind`, `base_url`, `secret` | an engine that is only a remote address |

On a `[[model]]`, `keep_resident = true` asks for that GGUF to be the one its
role returns to. Warmth is guaranteed against idleness, never against
contention: occupancy is still one model per role, so a request for a
different model on the same role wins the swap exactly as it does now, and
this only decides what loads again once nothing is waiting. Two models
declaring it on one role is fatal at parse, as is declaring it on a model with
no role -- both are unsatisfiable rather than merely unwise.

It pins the container up as well, because idle-stop stops the whole container
rather than unloading a model. An engine holding one never idle-stops and
keeps its share of the pool until engined reloads. That is the cost, and it is
why this is per model and opt-in.

Everything else passes through untouched. A first-class key not on that list
is a bug in the list rather than a passthrough.

## Turning something off

`disabled` is a top-level array of engine and chain names:

```toml
disabled = ["claude", "claude-kimi", "openai"]
```

A named engine is not startable and not dispatchable: its `[[model]]` entries
resolve to nothing, and every chain hop onto it drops out of that chain — so
`chain-public`, written with a local hop and three remote ones, serves the local
hop alone. A chain left with no hops is dropped with them rather than resolving
to an empty list. A chain name in `disabled` drops that chain only; the engines
it hopped through stay served.

The engine entry itself survives, marked, and `GET /v1/engines` reports it with
`disabled: true` and `state: "unavailable"` — see
[http-api.md](http-api.md#engine-state). What drops is everything that would
*validate* it: its models are not checked against a `models_dir`, its secret is
never resolved, and its container is never probed. That is what lets an engine
be turned off precisely because its weights or its key are not on this box, and
a reload that disables a running engine tears its container down.

A name that is neither an engine nor a chain is fatal, so a typo cannot quietly
leave something running. It is one list rather than a per-entry flag because
`[chain]` is a table of hop arrays with nowhere to hang one, and because "what
is off right now" is the operator's question.

## Required keys depend on what the entry describes

| Entry | Required | Absent by construction |
| --- | --- | --- |
| `[[model]]` on a llama engine | `id`, `engine`, `filename`, `role` | — |
| `[[model]]` on an agentic engine | `id`, `engine` | `filename`, `role` |
| `[[engine]]`, every kind | `id`, `egress` | — |
| `[[engine]]`, a remote address only | `id`, `egress`, `base_url`, `secret` | `spec_dir`, `models_dir`, `models_max` |

`filename` and `role` are absent from an agentic model because both exist to
account for occupancy, and an agentic attempt is never resident — the
reasoning that makes them fatal on a llama model is what makes them
inapplicable here. `egress` has no such exemption: every engine of every kind
declares it, because it is what `local_only` reads.

## Args

**Everything tunable is config, and it goes as deep as the model.**
`[engine.args]` carries an engine's process flags and `[model.args]` carries a
model's, rendered into that model's section of the presets INI.

Precedence is one line: **model args beat engine args, config args beat spec
args, and the floor beats everything.**

**On a remote engine, `[engine.args]` are wire parameters, not process
flags** — there is no process. They are handed to whichever dialect the door is
speaking: ElevenLabs' `model_id` for STT, `reasoning_effort` and anything else
an OpenAI-shaped upstream takes for chat, where the caller's own body wins over
the configured default.

A caller can also *unset* one, by sending the key as an explicit `null`: the
key is then dropped from the request rather than forwarded as a null. Without
that a wire default could be overridden but never removed, which strands any
caller whose own recovery from a vendor 400 is to drop the parameter and retry
-- engined would put the configured value straight back. A `null` written in
`[engine.args]` itself is unaffected: that is the operator asking to send one.

## Paths

`~/.local/share/` in a config path means "wherever engined's own data lives" —
the same base that gives the install directory — not literally the caller's
home. That one prefix routes through the XDG data home so a configured
`models_dir` stays a sibling of the install directory even when
`XDG_DATA_HOME` moves both. Any other tilde path is an ordinary home
reference.

The model tree is deliberately a **sibling** of the install directory, never
inside it: `install.sh` syncs the install directory with `rsync --delete`, and
nothing under it survives a sync it is not part of. The model tree is ~90 GB
that no download step would replace.

## Secrets

Secrets never live in the config. A remote engine names a keyring entry:

```toml
secret = { service = "elevenlabs-api", username = "scribe", header = "xi-api-key" }
```

```sh
secret-tool store --label='elevenlabs-api' service elevenlabs-api username scribe
```

Resolution is per request and never cached — see
[security-model.md](security-model.md). An engine with no key configured
reports `unavailable` naming the exact `secret-tool store` line that fixes it,
rather than failing at first use.
