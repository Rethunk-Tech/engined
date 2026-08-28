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
