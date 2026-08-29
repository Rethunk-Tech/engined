# Security model

engined is local-only: loopback TCP, no authentication, no tenancy, no TLS.
Everything below describes what that does and does not buy you.

## Agentic engines: integrity, not confidentiality

Agentic CLIs are an engine *kind*, not a separate API. They are launched with
writing structurally disabled, so they read a repository and return text like
any other completion, and engined never writes to a caller's worktree.

The guarantee is **integrity, not confidentiality.** `workdir` says where an
agent begins, not what it may read. Measured: under the full read-only floor,
an agent asked for `/etc/hostname` returns it, with no permission denial.

What an agentic call cannot do is *change* the caller's tree. What it
emphatically can do is read anything this uid can open — every private key,
the `gh` identity, the credentials of the CLI being run — and send it wherever
a chain ends. A workdir allowlist bounds nothing meaningful, since the fleet's
source lives inside any plausible root. A local process already reads those
files directly; what engined adds is convenience and an egress path.

**Adding a second, less-trusted caller is the moment this stops being
acceptable.**

The read-only floor is version-specific, so a proved version is only proof for
that version. Bumping `claude_version` re-runs the probe before engined will
serve requests through the new pin.

## The browser is a caller too

Loopback is reachable from any page the operator has open, and a cross-origin
`POST` carrying `Content-Type: text/plain` is not preflighted while
`req.json()` parses it anyway — so a page could name a `workdir` and a
remote-bearing chain and ship repository content off-machine without ever
reading the response.

So every request is origin-checked first, on every endpoint including reads. A
foreign `Origin`, an `Origin: null` (refused rather than treated as absent), or
a `Host` outside `{127.0.0.1, localhost, [::1]}` at the configured port is
refused. One middleware. A request carrying no `Origin` is served normally,
which covers every CLI and server consumer.

This is not authentication. It keeps the accepted risk at *reachable only by a
local process*, which is the case the argument above covers.

## What the Origin check does not guard

**It guards the door, not the containers behind it.** Managed engines publish
on loopback with no middleware in front. A page cannot read their responses
but does not need to — llama takes `/models/load` and Comfy takes a workflow
graph, and a side effect is enough. Ephemeral ports are not a control: a page
scans loopback faster than a human notices.

This is accepted and named rather than implied. Closing it would mean putting
managed containers on a docker network and reaching them from engined alone,
which the port read-back already makes possible.

One consumer is a browser: sagaforge's `/settings/engines` is a read-mostly
client of `GET /v1/engines`, and a page served from sagaforge's own origin
sends one. It is refused, and reaches engined through the sagaforge daemon it
is already talking to. Allowlisting a consumer's origin would reopen the hole
this check exists to close.

## The unit sandbox does not survive docker

`docker run` writes anywhere as root. Docker-group access is root-equivalent,
and the daemon whose core function is `docker run` holds that permanently,
regardless of `ProtectSystem=strict` on the unit that asked it to.

The sandbox bounds engined's own bugs and its non-container children — real,
and much narrower than "the filesystem is read-only". Anything that can
influence a container definition sits outside it, which is why a `spec_dir`
override is a privilege decision rather than a readability one: a spec
directory is trusted code, on the same footing as `main.js`.

See `scripts/engined.service.in`'s own comment for the measurement this rests
on.

## Secrets

Secrets never live in `config.toml`. A remote engine names a keyring entry and
engined resolves it per request, never cached — a `--user` unit boots before
the login keyring unlocks, and every remote engine must recover at the
operator's next sign-in without a reload.

A resolved secret reaches only the upstream request's headers or a child's
environment. It never reaches a log line, an error body, or a provenance
record; `recordCall` picks known fields explicitly so a caller that spreads a
headers object onto an attempt cannot leak one into journald.

## Prompts

No door logs a prompt. The only line engined writes per call is `recordCall`'s
provenance record — engine, model, outcome, timing — which has no field for
request content. An agentic child's stderr is dropped rather than forwarded to
journald: it is the one stream that can echo the prompt or the worktree the
child read, and a stream cannot be told apart from a diagnostic.

## Why cursor-agent was not shipped

Only `claude` ships. `cursor-agent`'s read-only mode could not be
demonstrated: it refuses to run at all in an untrusted directory, and with
`--plan --trust` it wrote nothing but produced no output either, so "the mode
held" and "it never ran" are indistinguishable. A kind whose read-only
enforcement has not been *shown* is not shipped.
