# Security model

engined's door listens on every interface with no authentication, no tenancy
and no TLS. Who can reach it is the operator's call: a firewall rule, a tunnel
that authenticates, or a reverse proxy with its own auth. Everything below
describes what the door itself does and does not guard.

## Agentic engines: integrity, and the operator's home stays closed

Agentic CLIs are an engine _kind_, not a separate API. They are launched with
writing structurally disabled, so they read a repository and return text like
any other completion, and engined never writes to a caller's worktree.

**Every agent runs under `bwrap`** (`src/sandbox.ts`): the filesystem bound
read-only, the operator's home masked with an empty tmpfs, `/run` and
`/var/tmp` as tmpfs (only the resolver's directory shown back from `/run`),
isolated IPC, PID and UTS namespaces, a new session, and no capabilities. Under the masked home, only
what the launch needs is bound back: the binary's own directory read-only, a
linked worktree's or submodule's git dir read-only, Bun's install cache behind
a throwaway overlay, the launch's own writable HOME, and the workdir,
read-only and bound last. Each launch gets a fresh HOME and XDG state. A
missing `bwrap` refuses the call rather than running loose, and the cache
overlay needs a `bwrap` that has `--tmp-overlay`.

A CLI that signs in with the operator's own account gets a **copy** of its
login file in that throwaway HOME, mode 0600: claude's
`~/.claude/.credentials.json`, cursor's `~/.config/cursor/auth.json`. The real
files are never mounted. `~/.gitconfig`, `~/.git-credentials`, `~/.ssh` and
the SSH agent socket stay out on purpose.

`claude` and `cursor` also honour an argv floor: claude's
`--safe-mode --tools Read,Grep,Glob --strict-mcp-config`, cursor's
`--mode ask --trust`, and `assertNoForbiddenFlags` stops a config unsaying
either. `opencode` exposes no such flag, so the mount table is its only floor.

An opt-in claude research call instead uses `--tools WebSearch,WebFetch` with
`--safe-mode --strict-mcp-config`: it can search and read the web but has no file
tools, so whatever it sends out can only be what is already in the prompt.

**Reading outside the workdir is closed under the operator's home.** An agent
told to read `~/.ssh/id_ed25519` or another repository under the home finds
nothing there.
What stays open:

- **Paths outside the home.** `/etc`, `/opt`, `/usr` and anything else this
  uid can read outside `$HOME` stay in the mount table, as they are to any
  local process. Whether a given agent's tools reach for them is that
  agent's own permission model, not a guarantee engined makes.
- **The agent's own environment.** `/proc/self/environ` is the child's and
  the agent can read it. A provider key is never in it: see the keyless
  upstream route below.
- **The network**, below.

A workdir under the home is visible because it is bound back. A workdir that
is the home, or an ancestor of it, re-exposes the whole home read-only, launch
HOME included: point an agent at a repository, never at the home.
A workdir that is the home, an ancestor of it, or one that is or contains a
`sandbox_mask` root is refused for the same reason.

## A provider key never enters a child

A claude route naming a real upstream does not hand the child that
upstream's key. Its `ANTHROPIC_BASE_URL` is the launch's keyless upstream
route, `http://127.0.0.1:<port>/engined/v1/upstream/<nonce>`, and its
`ANTHROPIC_API_KEY` is the fixed placeholder `engined-keyless`.
`ANTHROPIC_AUTH_TOKEN` is never set. The door forwards whatever the child
sends on that route to the one upstream the launch was routed to
(`src/launchUpstream.ts`): it strips any inbound `x-api-key` and
`authorization`, adds the real secret in the header and scheme the upstream's
`secret` names, and streams the reply back as it arrives. The secret is
resolved from the keyring on every forwarded request, the same never-cached
rule as everywhere else.

The route shares the launch's nonce and lifetime. Only a dispatch-path launch
routed to a real upstream maps its nonce to one; an ambient launch's nonce
and the probe's are refused on this route, and every nonce is refused once its
launch returns. The route reaches only that upstream's `base_url`, never a hop,
so it cannot recurse.

**What it leaves open is spend, not the key.** The nonce is in the child's
environment and the door answers the LAN, so for the life of a launch anyone
who can read the nonce, including the agent itself under a prompt that tells
it to, can send that upstream any model and any body on the operator's
account. They cannot take the key away, and the route closes when the launch
does.

## The launch-scoped door closes a recursion hazard

An agentic engine reaches its own model back through this door, so its launch
carries a door URL to call. Handing it the plain `http://127.0.0.1:<port>/openai/v1`
would let a hop on that URL resolve to another agentic engine, which could in
turn launch a further child — an unbounded recursion with nothing to stop it.

Every agentic launch instead mints a single-use, 32-character lowercase hex
nonce (`crypto.randomUUID()` with its dashes stripped) and hands the child
`http://127.0.0.1:<port>/openai/v1/<nonce>/...` instead. A request on that
path dispatches exactly like the plain surface, except a hop that resolves to
an `agentic-cli` engine — keyed on the resolved engine, never the caller's
literal `model` string, so a one-segment address that happens to resolve there
is caught the same as naming it outright — is refused with a 403 rather than
run.

The nonce is live only for the launch's own window: minted at the call
site, added to an in-memory set, and deleted the instant that call returns,
whether it succeeded or not. It is never written anywhere durable, so a leaked
or reused URL past that window is refused as unknown or expired, not treated
as a standing key.

The launch-scoped door stops a child from launching another agent. The
plain `/openai/v1` surface does not: a process on this box, or any LAN
client through the TLS bridge, can fan out launches. `agentic_concurrency`
(default 4) counts live dispatch-path launches — not the version-proof
probe — and answers an over-cap call 429 with `Retry-After` and the
OpenAI error shape.

**`cursor` is not covered by this, because nothing ever threads a door URL
into its launch at all.** Where a channel exists it carries the nonce:

- opencode's provider config always names it as the base URL its own model
  calls go through, since opencode's one route stays local.
- A claude route naming a real (non-ambient) upstream gets it alongside its
  keyless upstream route, so a tool reaching back into engined lands on the
  scoped surface rather than the plain one.

`cursor` has neither. It declares no `configure`, and no route
pairs it with a real upstream either: `CURSOR_API_KEY` is checked against
Cursor's own key format client-side before any network attempt, and no key
this box holds passes it, so redirecting cursor's own inference through
engined's door would turn every launch into a guaranteed failure. A `cursor`
launch reaches Cursor's cloud on this box's own login exactly as it would
running outside engined, with nothing in its environment pointing back at
this door at all -- not that the recursion control refuses cursor's reach-back,
but that there is no reach-back channel there for it to bound.

The read-only floor is version-specific, so a proved version is only proof for
that version. Bumping `agent_version` re-runs that agent's probes before
engined will serve requests through the new pin — and which probes those are
is per-agent too, because what could give an agent its tools back differs: a
planted settings hook for claude, a permissive `opencode.json` for opencode.

**The sandbox closes the host's local network, not the internet.** With
`pasta` (package `passt`) installed, the sandbox runs in a private network
namespace with outbound NAT: only the loopback ports named by the launch's
door URL are forwarded in, and the host's abstract-namespace Unix sockets
(X11) and loopback-only services are out of reach. Anything the host
listens on at a non-loopback address (the docker bridge `172.17.0.1`, `br-*`
bridge addresses, the tailscale IP, a LAN address), and the whole outbound
internet, stay reachable from the sandbox. Without `pasta` the launch is refused, as it is without `bwrap`. claude's argv floor also restricts which _tools_ it
has, so it cannot run shell or fetch a URL; opencode has no such restriction,
and cursor's ask mode still runs read-only shell. An agent pointed at a
private repository is trusted with its contents and can send them wherever
a chain ends.

## The browser is a caller too

The door is reachable from any page the operator has open, and a cross-origin
`POST` carrying `Content-Type: text/plain` is not preflighted while
`req.json()` parses it anyway — so a page could name a `workdir` and a
remote-bearing chain and ship repository content off-machine without ever
reading the response.

So every request is origin-checked first, on every endpoint including reads. Any
`Origin` (including `"null"`, refused rather than treated as absent), a
`Sec-Fetch-Site` other than `none` (a no-cors GET carries no `Origin`, and the
door serves no page, so `same-origin` means a hostile name rebound to this host)
is refused. One middleware. A request carrying no `Origin` and no
`Sec-Fetch-Site` is served normally, which covers every CLI and server consumer.

This is not authentication. It keeps a browser page from driving the door; a
process that can reach the port has the whole door.

## What the Origin check does not guard

**It guards the door, not the containers behind it.** Managed engines publish
on loopback with no middleware in front. A page cannot read their responses
but does not need to — llama takes `/models/load` and Comfy takes a workflow
graph, and a side effect is enough. Ephemeral ports are not a control: a page
scans loopback faster than a human notices.

This is accepted and named rather than implied. Closing it would mean putting
managed containers on a docker network and reaching them from engined alone,
which the port read-back already makes possible.

One consumer is a browser: a video-production consumer's browser-based
settings page is a read-mostly client of `GET /engined/v1/engines`, and a
page served from that consumer's own origin sends one. It is refused, and
reaches engined through the daemon it is already talking to. Allowlisting a
consumer's origin would reopen the hole this check exists to close.

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

Inside that, every engine container runs with `--cap-drop ALL`,
`--security-opt no-new-privileges` and `--pids-limit 4096`
(`src/dockerArgs.ts`): GPU access is the spec's `--device` and `--group-add`,
which need no capability. Each still sits on docker's default bridge, so a
compromised engine can reach the LAN, the internet and the door through the
bridge gateway. A docker `--internal` network does not close that on its own:
docker drops the `-p` publish engined reads the port back from, and the
gateway address still reaches every host listener on all interfaces,
the door included.

## Anyone who reaches the door has all of it

A client of the door, directly or through the `engined-tls` Caddy bridge
(`deploy/Caddyfile.cursor`, port 29443, for clients such as Cursor that need
HTTPS), has the whole door, including agentic calls that read the workdir
they name and anything this uid can open outside its home, and remote routes
that spend provider credit. Restricting
who reaches it is the operator's responsibility.

## The config UI is a root-equivalent writer

`engined --configsvc` (the `engined-configsvc` unit) edits `config.toml`, and
that is not a harmless file. A config can set `spec_dir` to any directory, and
a spec directory is trusted code that `docker run` executes as root (the
section above), so whoever can save a config can run a container as root. The
UI is therefore gated like the privilege it holds:

- **Login.** Without `[configsvc] password_hash` it mints a random token on each
  start and logs a URL that carries it; with a hash (`engined --hash-password`,
  argon2id) it takes that password. Five wrong tries a minute lock a client out
  and a session ends after 12 hours idle. The cookie is `HttpOnly` and
  `SameSite=Strict`.
- **Loopback.** The listener always binds `127.0.0.1`, and a request whose
  `Host` is not a loopback name at its port, or whose `Origin` is not its own,
  is refused. A page on another origin cannot drive it.
- **Page.** Everything the page loads is bundled and served by the configsvc,
  nothing from a CDN. It refuses to be framed (`X-Frame-Options: DENY`). There is
  no Content-Security-Policy, deliberately: it broke the editor's own styles and
  guards nothing the session cookie, Origin check and framing refusal do not.
- **Audit.** Each save logs one line with the client, what changed and the
  before and after hashes. The previous file is kept in `.history/`.
- **Secrets.** A value typed into the UI goes to `secret-tool` on stdin and is
  never read back; the UI only learns whether an item exists. Only items under
  engined's own keyring prefix can be stored or cleared (see Secrets below).

**LAN access goes through TLS.** When `[configsvc] host` names something other
than loopback, the UI still listens on loopback only. The `engined-tls` Caddy
renders a site for `https://<host>:29444` that proxies to it, the page logs the
https URL, and the UI accepts that one `Host` (with an https `Origin` of the
same name), sets `Secure` on its cookie and rate-limits by the forwarded
client address only when Caddy's hop header is present. A loopback caller
that spoofs the bridged `Host` does not get to pick the lockout key.
`host` is a name or address clients dial, never `0.0.0.0`.
Restart `engined-tls` after changing it: the Caddyfile is rendered when the
unit starts (`engined --caddyfile`). Caddy's internal CA signs the site, so a
browser needs that root once, as for the Cursor door.

Reaching the bridge is reaching a root-equivalent editor: the token or password
is the only gate, and a token log line is readable by anything that reads the
user's journal. Prefer `password_hash` for any host that is not loopback, and
the firewall and tunnel advice for the Cursor bridge applies here too.

## Secrets

Secrets never live in `config.toml`. Every keyring item engined reads, stores
or clears carries `service engined`, with the config's `service` as its `name`
attribute, so neither a saved config nor the config UI can read, overwrite or
clear another program's login item. A config naming one (a browser's safe
storage key, say) resolves as missing. An older secret at `service <service>
username <username>` is read there once and moved under the prefix, only for
the refs the config named when a prefixed build first ran; the old item is
never deleted.

A remote engine names a keyring entry and
engined resolves it per request, never cached — a `--user` unit boots before
the login keyring unlocks, and every remote engine must recover at the
operator's next sign-in without a reload.

A resolved secret reaches only the headers of a request engined itself sends
upstream, including the keyless forwarder's. It never reaches a child's
environment or argv, a log line, an error body, or a provenance record; `recordCall` picks known fields explicitly so a caller that spreads a
headers object onto an attempt cannot leak one into journald.

## Prompts

No door logs a prompt. The only line engined writes per call is `recordCall`'s
provenance record — engine, model, outcome, timing — which has no field for
request content. The stderr of a child running a caller's prompt is dropped
rather than forwarded to journald: it is the one stream that can echo the prompt
or the worktree the child read, and an echo cannot be told apart from a
diagnostic. The one stderr that does surface is a probe's, in the engine's `fix`
line: that child runs a fixed write instruction in a scratch worktree, never a
caller's prompt.

## Which agents ship, and why

The rule is the same for all of them: **an agent whose read-only enforcement
has not been _shown_ is not shipped.** What differs is how each one was shown.

`claude` ships on its own flags under the sandbox. The argv floor is
re-proved by the probes against every new pin.

`opencode` ships on the sandbox, and only on the sandbox. Measured against
1.18.25: it has no tool or permission flag; an `OPENCODE_CONFIG` floor denying
`edit`, `bash` and `write` was overridden by a project `opencode.json`; the
built-in read-only `plan` agent was redefined the same way, because its rules
are last-wins; and config is discovered by walking _up_ from the working
directory, so the exposure is not even bounded to the workdir. Its own
configuration therefore cannot be a floor.

Under `bwrap` it can be shown
instead, and was: with that permissive config planted in the workdir and its
parent, opencode ran its `write` tool and then fell back to `printf >`, and
both returned `Read-only file system` with the tree unchanged. That run is
kept as `test/local/opencode.test.ts`.

The gate itself does not repeat that round trip. A sandbox floor does not come
from the pin, so a pin bump cannot drop it; what a bump must re-check is that
this box still has a working `bwrap`. The `sandbox-refuses-writes` probe binds
a scratch directory the way a real launch binds a workdir and requires a write,
a `systemd-run --user --wait true` launch, and a connection to
`/run/docker.sock` to fail — the kernel does not care which binary is writing,
so that proves what an agent round trip would, in milliseconds and with no LLM
in the loop to be nondeterministic about.

`cursor-agent`'s floor is **argv, like claude's**, under the same sandbox — first measured against
2026.08.28-50f0823 as `--mode plan`, then moved to `--mode ask` against
2026.10.08-4f5c08d after plan mode stopped holding. It launches: the
binary is resolved from PATH or `~/.local/share/cursor-agent/versions/`, not
from npm, and both its directory and its target's are bound back into the
sandbox. It stays disabled for the reason above — nothing can thread a door URL
to it — not for want of a launch path.

Under `--mode ask --trust` a write instruction left the worktree byte-identical
and the stream showed no `SwitchMode` and no write tool. `--mode plan` on
2026.10.08-4f5c08d is not a floor: the same prompt `SwitchMode`'d to agent and
created `proof.txt`. A permissive `.cursor/cli-config.json` allowing `Write`
and `Shell(*)`, planted in the workdir and its parent the way opencode's was,
did not move the older plan-mode refusals. The control is what makes those
refusals mean anything: the same request under plain `-p` created the file, so
writes were available in that directory throughout.

**Read it with `--output-format stream-json`, never `text`.** A refused write
emits an empty `text` stream — which is exactly the ambiguity that sank the
first attempt. The tool calls and the refusal are visible only in the JSON
stream, so the format is part of the floor's evidence, not a preference.

Ask mode is the floor because it cannot switch to agent the way plan mode
did. Plan mode's older extra claim — refusing **network egress of any verb**
under `--mode plan --trust` — was measured on 2026.08.28-50f0823 and is not
re-claimed for ask. The write probe is what the pin now proves.

`--force`, `--yolo`, and `--sandbox` (including `--sandbox disabled`) are
refused by name before a launch or a probe spawns `cursor-agent`. The
forbidden-flag assertion is what holds that: a request carrying any of them
fails, and the binary is never asked whether the flag would override
`--mode ask`. A config planted at the workdir and its parent is the
repo-borne threat, not proof that no config anywhere can unsay the flag.
