# Configuration

`config.toml` lives at `$XDG_CONFIG_HOME/engined/config.toml`
(`~/.config/engined/config.toml` when XDG is unset). `config.example.toml` in
the repo root is a worked, committed reference covering every engine this repo
ships a spec for; `src/config-example.test.ts` parses it with the real loader
on every run, so it cannot go stale.

Every rule here is fatal at parse. A daemon serving a config it cannot fully
trust is worse than one that refuses to start.

Five tables describe a machine, none owning another: `[[upstream]]` is where
the bytes for a request come from and carries `base_url`, `secret` and
`egress` — an engine has no address of its own. `[[engine]]` is a way to
execute a request. `[[model]]` is optional, declared only where there is a
capability worth recording. `[[route]]` pairs an engine with an upstream and,
where one applies, a model, and carries everything specific to that pairing:
`filename`, `role`, `vision`, `translate`, `keep_resident`, `wire_model`, `streaming`, `args`. `[[chain]]` is an
ordered fallback list of route addresses.

## Config versus spec, and why the split is not tidiness

An engine's *shape* is not configuration. Every engine engined launches is a
directory shipped with the repo at `engines/<id>/`, holding a `spec.toml`, the
Dockerfile when the image is built locally, and any file the container needs
mounted. `config.toml` names the engine and supplies only what varies by
install.

An engine that is merely a remote address has nothing to launch and names its
upstream instead: `base_url`, `secret` and `egress` live there, never on the
engine.

## The closed key set

Only keys engined's own logic reads stay first-class, and that list is closed
per table — `src/config.ts`'s `ENGINE_KEYS`, `UPSTREAM_KEYS`, `MODEL_KEYS`,
`ROUTE_KEYS` and `CHAIN_KEYS` each enforce their own. A typo'd key is a parse
error by design rather than a silent no-op.

| Key | Applies to |
| --- | --- |
| `id`, `disable` | every `[[engine]]`, `[[upstream]]`, `[[route]]` and `[[chain]]` |
| `spec_dir` | override the shipped spec directory (a privilege decision — see [security-model.md](security-model.md)) |
| `models_dir` | engines with a host model tree |
| `models_max` | llama occupancy floor; fatal below the number of distinct roles configured |
| `idle_stop_seconds` | how long an engine may sit unheld before it stops |
| `ready_timeout_s` | how long a start may take to pass its readiness probe |
| `drain_timeout_seconds` | how long a submission waits for the engine to be free before it is refused. Only the comfy proxy holds submissions, which is what makes an unscoped `/interrupt` safe — see [http-api.md](http-api.md#comfy). Not a render-length estimate: it is the ceiling that stops a wedged container parking every later submission forever, so it is the key to raise when a real render legitimately runs past it. Must be greater than zero — `0` is refused at load rather than read as "never try". Default 15 minutes |
| `agent_version` | agentic engines; substituted as `{agent_version}`, never `@latest` |
| `kind` | an engine that ships no spec directory and takes a built-in spec |
| `base_url`, `secret`, `egress`, `wire` | `[[upstream]]` only — where the bytes come from and what wire shape it speaks (`"openai"` or `"anthropic"`). The id `local` is reserved for this box: declaring it with a `base_url` or `secret` is a parse error, so no config or learned name can point it off-machine |
| `scheme` on `secret` | the auth prefix (e.g. `"Bearer"`) a provider expects before the resolved credential; absent means the header carries the raw value |
| `engine`, `upstream`, `model`, `wire_model`, `filename`, `role`, `vision`, `translate`, `keep_resident`, `streaming` | `[[route]]` — the pairing itself, and everything specific to it. `wire_model` is the id the upstream actually knows, sent on the wire in `model`'s place, for when that real id contains a `/` the address grammar cannot carry. `streaming` overrides the engine spec's own answer for this one route, for a provider tier that cannot chunk what its siblings can |
| `hops` | `[[chain]]` — an ordered list of route addresses |

On a `[[route]]`, `keep_resident = true` asks for that GGUF to be the one its
role returns to. `filename`, `role` and `keep_resident` all live on the route,
not the model — `ornith` on `llama` has a GGUF file and a role, `ornith`
through `claude` has neither.

`translate` says this STT model's weights are multilingual, so it can render
speech in another language as English. Only an `stt` route may declare it, and
a route that does not declare it does not serve
`/openai/v1/audio/translations` at all -- the failure it guards is silent, not
loud: whisper handed the translate flag with English-only weights transcribes
rather than erroring.

`vision` says what a `role = "vision"` model does with an image, which the
role itself does not: `"describe"` reads a scene back in prose, `"read"`
recognises the characters printed in one. Both take an image and answer in
text, so nothing else on a route tells them apart — a consumer wiring up OCR
and one wiring up captioning are picking between two addresses that otherwise
look identical. It is required on a vision route and a parse error on any
other — not defaulted, because the default would be wrong for whichever kind
it did not name, and a reader sent the describer's check fails it while working
correctly with nothing in that failure pointing at the config.

It is also what decides which ground-truth check the vision probe sends
([engines.md](engines.md#vision-fidelity-llama-vulkan)): a describer is asked
to name two colours in order, a reader to read a freshly generated digit
string back. Sending either question to the other model fails a model that is
working correctly.

Warmth is guaranteed against idleness, never
against contention: occupancy is still one model per role, so a request for a
different model on the same role wins the swap exactly as it does now, and
this only decides what loads again once nothing is waiting. Two routes
declaring it on one role is fatal at parse, as is declaring it on a route with
no role -- both are unsatisfiable rather than merely unwise.

It pins the container up as well, because idle-stop stops the whole container
rather than unloading a model. An engine holding one never idle-stops and
keeps its share of the pool until engined reloads. That is the cost, and it is
why this is per model and opt-in.

Everything else passes through untouched. A first-class key not on that list
is a bug in the list rather than a passthrough.

## Turning something off

`disable = true` on an `[[engine]]`, `[[upstream]]`, `[[route]]` or `[[chain]]`
takes it out of service without deleting it — four levels, not one flat list,
because a weight, a key, a single pairing, or a whole fallback order can each
be the thing not on this box yet:

```toml
[[engine]]
id      = "openai"
kind    = "openai-http"
disable = true
```

A disabled engine drops every route naming it; a disabled upstream drops every
route naming *it*; a disabled route drops just that one pairing, its siblings
survive; a disabled chain is not served at all. A chain hop whose engine,
upstream or route is disabled drops silently out of that chain rather than
failing it — the rule is over the resolved hop address, not the engine
segment alone — and a chain left with no hops drops too. `chain-public`,
written with one local hop and three remote ones, serves the local hop alone
while `claude` and `openai` stay disabled.

The entry itself survives, marked, and `GET /engined/v1/engines` reports it
with `disabled: true` and `state: "unavailable"` — see
[http-api.md](http-api.md#engine-state). What drops is everything that would
*validate* it: its models are not checked against a `models_dir`, its secret is
never resolved, and its container is never probed. That is what lets an engine
be turned off precisely because its weights or its key are not on this box, and
a reload that disables a running engine tears its container down.

`[[model]]` takes no `disable`: it would mean "every route naming this model
drops", which is disabling those routes directly, and a route may name a model
with no `[[model]]` row at all.

## Required keys depend on what the entry describes

| Entry | Required | Absent by construction |
| --- | --- | --- |
| `[[route]]` on a llama engine | `engine`, `upstream`, `model`, `filename`, `role` | — |
| `[[route]]` on an agentic engine | `engine` | `filename`, `role` |
| `[[engine]]`, every kind | `id` | — |
| `[[upstream]]`, an address only | `id`, `egress`, `base_url`, `secret` | — |

`filename` and `role` are absent from an agentic route because both exist to
account for occupancy, and an agentic attempt is never resident — the
reasoning that makes them fatal on a llama route is what makes them
inapplicable here.

`egress` lives on the upstream, not the engine, because it
answers "where do these bytes actually go", a question an engine alone cannot
answer — `claude` pointed at `moonshot` and `claude` pointed at `openrouter`
share an engine and differ only in upstream.

A request declares `max_egress`
as a ceiling, compared against a route's egress via the ordered
`EGRESS_RANK {none, lan, remote}` and `withinCeiling()` — never a bare `<`/`<=`
on the strings themselves, since alphabetically `"lan" < "none" < "remote"`
would admit a `lan` hop under a `"none"` ceiling.

## Args

**Everything tunable is config, and it goes as deep as the route.**
`[engine.args]` carries an engine's process flags and `[route.args]` carries a
route's, rendered into that route's section of the presets INI.

Precedence is one line: **route args beat engine args, config args beat spec
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

Secrets never live in the config. A remote upstream names a keyring entry,
with an optional `scheme` for a provider that expects an auth prefix before
the credential (e.g. `"Bearer"` — absent means the header carries the raw
value):

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
