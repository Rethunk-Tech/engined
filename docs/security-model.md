# Security model

engined is local-only: loopback TCP, no authentication, no tenancy, no TLS.
Everything below describes what that does and does not buy you.

## Agentic engines: integrity, not confidentiality

Agentic CLIs are an engine *kind*, not a separate API. They are launched with
writing structurally disabled, so they read a repository and return text like
any other completion, and engined never writes to a caller's worktree.

**Where that floor comes from is per-agent**, and `src/agents.ts` says which.
`claude` honours one passed in argv (`--safe-mode --tools Read,Grep,Glob
--strict-mcp-config`), and `assertNoForbiddenFlags` stops a config unsaying
it. `opencode` exposes no such flag at all, so engined runs it under `bwrap`
with the workdir bound read-only. An agent declared `sandbox` never launches
without it: a missing `bwrap` refuses the call rather than running loose.

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
that version. Bumping `agent_version` re-runs that agent's probes before
engined will serve requests through the new pin — and which probes those are
is per-agent too, because what could give an agent its tools back differs: a
planted settings hook for claude, a permissive `opencode.json` for opencode.

**The two floors are not equally shaped.** claude's also restricts which
*tools* it has, so it cannot run shell or fetch a URL. The sandbox restricts
writing only: it shares the host network namespace, because the agent has to
reach this door to reach a model at all. That costs no guarantee this document
makes — confidentiality was never one, per the paragraphs above — but it does
remove an incidental protection claude happened to provide. An agent pointed
at a private repository is trusted with its contents under either floor.

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
client of `GET /engined/v1/engines`, and a page served from sagaforge's own origin
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

## Which agents ship, and why

The rule is the same for all of them: **an agent whose read-only enforcement
has not been *shown* is not shipped.** What differs is how each one was shown.

`claude` ships on its own flags. The floor is argv, and the probes re-prove it
against every new pin.

`opencode` ships on the sandbox, and only on the sandbox. Measured against
1.18.25: it has no tool or permission flag; an `OPENCODE_CONFIG` floor denying
`edit`, `bash` and `write` was overridden by a project `opencode.json`; the
built-in read-only `plan` agent was redefined the same way, because its rules
are last-wins; and config is discovered by walking *up* from the working
directory, so the exposure is not even bounded to the workdir. Its own
configuration therefore cannot be a floor. Under `bwrap` it can be shown
instead, and was: with that permissive config planted in the workdir and its
parent, opencode ran its `write` tool and then fell back to `printf >`, and
both returned `Read-only file system` with the tree unchanged. That run is
kept as `test/local/opencode.test.ts`.

The gate itself does not repeat that round trip. A sandbox floor does not come
from the pin, so a pin bump cannot drop it; what a bump must re-check is that
this box still has a working `bwrap`. The `sandbox-refuses-writes` probe binds
a scratch directory the way a real launch binds a workdir and requires a plain
`sh` write into it to fail — the kernel does not care which binary is writing,
so that proves what an agent round trip would, in milliseconds and with no LLM
in the loop to be nondeterministic about.

`cursor-agent`'s floor is **argv, like claude's** — measured against
2026.08.28-50f0823, and it does not yet ship only because its `AGENTS` entry is
still to be written.

Under `--mode plan --trust` it answered a question about a file in the workspace
with the file's actual contents, so it demonstrably ran; asked to create a file
in the same mode it wrote nothing, said *"Plan mode blocks file writes"*, and
reached for its plan tool instead of a write tool. A permissive
`.cursor/cli-config.json` allowing `Write` and `Shell(*)`, planted in the
workdir and its parent the way opencode's was, did not move it. The control is
what makes those refusals mean anything: the same request under plain `-p`
created the file, so writes were available in that directory throughout.

**Read it with `--output-format stream-json`, never `text`.** A refused write
emits an empty `text` stream — which is exactly the ambiguity that sank the
first attempt. The tool calls and the refusal are visible only in the JSON
stream, so the format is part of the floor's evidence, not a preference.

Two things this does not settle. Whether `--force`/`--yolo` or
`--sandbox disabled` override `--mode plan` was not tested, so all three belong
in the forbidden-flag assertion regardless of what they turn out to do. And a
config planted at those two paths is the repo-borne threat, not proof that no
config anywhere can unsay the flag.
