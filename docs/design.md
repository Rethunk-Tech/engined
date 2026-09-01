# Design record

## The ownership line

engined owns the engine, upstream, model, route and chain tables and their
shape, secret resolution, address resolution, chain ordering and fallback,
OpenAI `model` dispatch, llama.cpp occupancy, container lifecycle for every
managed engine, the spec directory that describes each one, invocation of
every kind including `agentic-cli` and the read-only launch arguments that
make it safe, and provenance.

Consumers own prompts, context assembly, output parsing, Comfy graphs, which
chain or model string to send, and writing to disk whatever they keep from
what an agent returned.

**engined knows nothing about the task.** If changing a feature's prompt would
require an engined change, the line has been drawn wrong.

## Sole ownership of local inference

Nothing else on this box starts an inference container: under load, `docker
ps` shows `engined-*` only. `majordomo`, `paper-trail`, `sagaforge-ts`,
`bastion-client-discord`, `citadel` and `prepaudit` all reach this door for
chat, embeddings, vision, speech and transcription, and none of them
supervises a server, downloads weights, or holds a provider key.

A consumer that keeps its own runner has not been cut over, only pointed
twice.

`Rethunk-AI/bakeoff` is the one deliberate exception. It is a benchmark
harness whose whole purpose is measuring engine *configurations*, and routing
it through a broker that owns the args would measure the broker instead. It
never runs concurrently with production inference.

## Why 29200

Unassigned, and stays that way. IANA lists 29170–29998 with no service in it;
it sits below the ephemeral floor (`ip_local_port_range` starts at 32768 here)
so no outbound connection can take it first; it avoids the `188xx` block
sagaforge reserves and the informal squatters nearby — PyTorch distributed
defaults distributed training port to 29500, Gerrit uses 29418.

The alternative was 8080, `llama-server`'s own default. Every consumer
hardcodes the address anyway, so guessability buys one line of config while
the cost is permanent: 8080 is the most commonly occupied dev port on a
workstation, and engined is not always running. With engined down and anything
else on 8080, consumers deliver document text, conversation turns and
`workdir` paths naming private repositories to whatever holds the port, and
get back a 404 page they report as a parse error. An unassigned port turns
that silent misdirect into `ECONNREFUSED`. The known holder of 8080 here is
`bakeoff`, binding it for `llama-swap`.

**The door is the only port engined writes down for anything it runs.** The
container side comes from the image's `EXPOSE`, the host side from Docker.
The sole other exception is a remote upstream's `base_url`.

## Deliberately not built

No install, build or update endpoint for *engines* and no stepper UI —
`docker build` by hand, and a missing image reports `unavailable` plus the
literal command. engined's own install is a script, never a route: nothing
reachable over HTTP writes to the install directory.

No `/v1/complete`, no `/v1/agent`, no `/v1/health` — contract version, parse
state and reachability all live in `GET /engined/v1/engines`, and a `Type=simple` unit
needs no liveness probe. No `GET /v1/runs/:id` — a file read on a client-supplied id with no named
consumer, where `journalctl --user -u engined` is the whole feature.

No `engine` CLI until someone types the same `curl` twice. No capability
matrix, image-sampling defaults, or GPU-wide resource-group mutex. Two locks
in scope: the per-engine **start lock** and the per-role **lease**.

The GPU-wide mutex was reconsidered and measured rather than assumed: one
resident 35B model costs ~27 GiB of a 133 GB shared pool and idle-stop returns
it, so three resident engines still sit inside the pool. It stays unbuilt
until a measured peak actually approaches that ceiling.

No multi-machine, auth, tenancy or web UI — the operator surface is
`GET /engined/v1/engines`. No stub adapter, for the same reason the tests carry no
mocks: every trap here was tool behaviour rather than logic, and a fake
reproduces the logic and none of the behaviour.

**Comfy is reached only through a mediated proxy**, never at a raw container
address — see [http-api.md § Comfy](http-api.md#comfy). engined manages its
container lifecycle and forwards every real call through the door by address;
no `private_url` ever reaches a consumer, which is what keeps call recording,
egress ceilings and a later budget in one place instead of letting a held
address route around them.

**No `Bun.serve` declarative routes.** Measured against bun 1.3.14, not
assumed: all five engine-path regexes are expressible as `:id` routes, and SSE
under a route handler was probed working -- `req.signal` fires and the stream's
`cancel()` runs, which is what the engine-event feed's teardown needs. It is
still refused. `Bun.serve` has no pre-route hook (the `fetch` option is only
the unmatched-route fallback, probed), so the Origin/Host check that is now one
unbypassable chokepoint in `createDoor`'s `fetch` would have to be re-applied
by wrapping every route value -- a route added without the wrapper would
silently skip it. And `routes` exists only as a `Bun.serve` option with no
offline matcher, so the 57 socket-free `door.fetch(new Request(...))`
assertions would all become network round-trips. The trade is -53 source lines
for a fail-open security boundary and a slower, larger test surface.
Reconsider only if Bun ships a documented pre-route middleware hook.

Add any of these when a second consumer, modality or person makes the case.
