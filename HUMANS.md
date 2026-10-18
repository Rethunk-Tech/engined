# Running engined

Install, configure, operate and remove engined on a workstation. Deep reference
is under [`docs/`](docs/) and linked from [README.md](README.md).

## Prerequisites

- Linux with `systemd --user`
- Docker, with your user in the `docker` group
- git and rsync (install syncs `engines/` with `rsync --delete`)
- [Bun](https://bun.sh) on `PATH` (or `ENGINED_BUNX` set)
- `secret-tool` (libsecret) for any engine that needs a key
- For GPU engines, the shipped images target AMD Strix Halo / gfx1151, ROCm 7.2+

Operator environment (the `--user` unit sets the first two):

| Variable | What it does |
| --- | --- |
| `ENGINED_BUNX` | Absolute `bunx`. Unset, a working-tree run uses `bunx` on `PATH`; missing both is fatal at start |
| `ENGINED_INSTALL_DIR` | Directory holding `main.js` and `engines/`. Packages set `/usr/lib/engined`; `install.sh` uses `$XDG_DATA_HOME/engined`. A relative value is ignored |
| `ENGINED_BWRAP` | Absolute `bwrap` for opencode's read-only floor. Unset uses `PATH`. A sandbox agent with none found refuses the call |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` | Config (`…/engined/config.toml`), install/models sibling, and writable state. Relative values are ignored |
| `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` | Claude model discovery: the API key, else the Claude CLI login under `CLAUDE_CONFIG_DIR` or `~/.claude` |
| `ENGINED_LOCAL` | Set to `1` to run `bun run test:local` against real containers |

## Install

```sh
brew install rethunk-tech/tap/engined
```

On Arch, from the AUR:

```sh
paru -S engined       # built from the release tag
paru -S engined-git   # built from main
```

The package installs to `/usr/lib/engined` and ships the units in
`/usr/lib/systemd/user`; enable them per user, as the install message says.
Everything below about `install.sh` is for a clone.

Anywhere else, from a clone:

```sh
git clone https://github.com/Rethunk-Tech/engined.git
cd engined
bash scripts/install.sh
```

Install runs from a git checkout: the build stamps the commit it came from.
Every `engines/*/spec.toml` names a `*:local` image, so there is nothing to
pull from a registry and install never builds one for you. The first request
to an engine whose image is missing fails with the `docker build` line to
run; [docs/engines.md](docs/engines.md) says what each image needs.

Builds a bundle, syncs `engines/` into `~/.local/share/engined/`
(`$XDG_DATA_HOME/engined/` when set), creates `~/.config/engined/` so a
following `cp` has somewhere to land, and renders the `systemd --user` units.
It restarts `engined` only when `config.toml` is already there; without one the
daemon would start and answer 503 until a config is written and reloaded. Running the script again **is** the update — nothing
over HTTP writes to the install directory.

Install also enables `engined-configsvc.service` (the config UI, below); it
starts when `config.toml` is missing or invalid, and exits at once only when a
valid config does not set `[configsvc] enable = true`.

When Docker is on `PATH`, install also enables `engined-tls.service`: a
`engined-tls` container running `deploy/Caddyfile.cursor` so the Cursor door
can speak TLS. See [docs/security-model.md § The Cursor TLS bridge](docs/security-model.md#the-cursor-tls-bridge-is-a-network-listener).

Completions (bash, zsh, fish, PowerShell) and a man page are
`engined-completions-man.tar.gz`:

```bash
curl -fsSLO https://github.com/Rethunk-Tech/engined/releases/latest/download/engined-completions-man.tar.gz
curl -fsSLO https://github.com/Rethunk-Tech/engined/releases/latest/download/engined-completions-man.tar.gz.sha256
sha256sum -c engined-completions-man.tar.gz.sha256
mkdir -p /tmp/engined-assets
tar -xzf engined-completions-man.tar.gz -C /tmp/engined-assets
```

```bash
install -Dm644 /tmp/engined-assets/engined.bash ~/.local/share/bash-completion/completions/engined
```

```zsh
install -Dm644 /tmp/engined-assets/_engined ~/.local/share/zsh/site-functions/_engined
```

```fish
install -Dm644 /tmp/engined-assets/engined.fish ~/.config/fish/completions/engined.fish
```

```powershell
Add-Content $PROFILE '. /tmp/engined-assets/engined.ps1'
```

**Never run it under `sudo`.** Root-owned outputs break later user-level builds.

The sync uses `rsync --delete`; the model tree is a sibling of the install
directory — [docs/configuration.md § Paths](docs/configuration.md).

## Configure

```sh
mkdir -p ~/.config/engined
cp config.example.toml ~/.config/engined/config.toml
$EDITOR ~/.config/engined/config.toml
systemctl --user restart engined.service
```

Name engines you have images for and GGUFs on disk. A missing file or spec
fails at parse. Secrets go in the keyring, not the config:

```sh
secret-tool store --label='elevenlabs-api' service elevenlabs-api username scribe
```

Opt a local llama chat route into fill-in-the-middle, or give a text-only
chat route an image-attach path through a vision route on the same box —
both are per route, both shown on the `ornith` route in
[config.example.toml](config.example.toml):

```toml
[[route]]
engine        = "llama"
upstream      = "local"
model         = "ornith"
role          = "chat"
fim           = true                 # answers POST /openai/v1/completions alongside chat
vision_bridge = "@/llama/vision"     # must resolve to a served role = "vision" route
```

Full schema: [docs/configuration.md](docs/configuration.md).

## Verify

```sh
curl -s localhost:29200/engined/v1/engines | jq '.engines[] | {id, state, fix}'
```

Every engine should be `installed`, `running`, or `unavailable` **with a `fix`**
naming the literal command to resolve it. Then one real request:

```sh
curl -s localhost:29200/openai/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"chain-private","messages":[{"role":"user","content":"say OK"}],"max_tokens":16}'
```

The first call to a stopped engine starts its container and waits for readiness.

## Operate

```sh
curl -s localhost:29200/engined/v1/engines | jq     # state and fix for unavailable
journalctl --user -u engined -f             # one JSON line per call
systemctl --user reload engined             # re-read config.toml
systemctl --user restart engined            # full restart
engined --help                              # every mode below; does not start the door
engined --version                           # tool version
engined --doctor [--json]                   # host checks, one line each with its fix
engined --probe [--json]                    # call the already-serving door; never bind a second one
engined --engines --json                    # print GET /engined/v1/engines ( --json is required; no text listing)
engined --prune-config CONFIG --out OUTPUT  # drop duplicate/retired discovery routes; never writes in place
engined --configsvc                         # config web UI (the engined-configsvc unit)
engined --configsvc-url                     # URL the config UI logged at its last start
engined --hash-password                     # one line on stdin -> argon2id hash for [configsvc] password_hash
engined --caddyfile TEMPLATE OUT            # render the TLS-bridge Caddyfile (the engined-tls unit runs it)
```

For a quick per-day, per-route total without folding journald yourself:

```sh
curl -s 'localhost:29200/engined/v1/usage?days=7' | jq
```

What a paid upstream has cost in finer detail is those same lines. Each
attempt carries the `usage` the engine reported, so a month is a sum rather
than a provider dashboard:

```sh
journalctl --user -u engined --since '30 days ago' -o cat \
  | jq -s '[.[].attempts[] | select(.upstream_used=="openrouter")]
           | {calls: length,
              tokens: ([.[].usage.total_tokens // 0] | add),
              unknown: ([.[] | select(.usage == null)] | length)}'
```

`unknown` is the count the sum cannot see: a streamed reply and an agentic
hop each report no usage, and counting them as zero would understate the
month. [docs/http-api.md § What a call cost](docs/http-api.md#what-a-call-cost)
says which absence is which.

`POST /engined/v1/engines/<id>/obtain` fetches an engine's missing model files:
it runs the spec's `[[artifact]]` obtain commands (the ones its `fix` field
names) for artifacts not on disk yet, in order. An artifact marked
`route_file = true` is a weights file a route picks with `filename`, so it is
fetched, and required at start, only while an enabled route names it. A spec's
`route_file_env = "NAME"` makes a start set that env var to `/models/<filename>` (piper's
`PIPER_VOICE_PATH`), and a `[[volume]]` marked `optional = true` is dropped when its
`{models_dir}` placeholder has no value. It streams SSE events `step`
(`{step, command}`), `line` (`{step, stream, line}`) and a final `exit`
(`{exitCode, steps}`; `steps` is 0 when nothing was missing). It stops at the
first failing command, kills the command if the client disconnects, answers 404
for an engine whose spec declares no artifacts and 409 while one is running.

### The config UI

A browser editor for `config.toml`, run by its own unit (`engined-configsvc`, `main.js --configsvc`). It is
the only writer of the file, it never starts or stops an engine, and it reloads engined only by the signals
in the table below when you ask.

**Open it.** `engined --configsvc-url` prints the URL the unit last logged (the same line is in
`journalctl --user -u engined-configsvc`). The URL carries a one-time token that is minted at every start;
the page trades it for a session cookie and drops it from the address bar. The unit listens on
`127.0.0.1:29202`.

**Enable or disable it.** It runs when `[configsvc] enable = true`. A valid config without that exits the unit
with status 0; a missing or broken config still starts it, so the file can be repaired through it.
`install.sh` enables the unit either way and prints `engined --configsvc-url` on a box with no config.

**Password mode.** Set `[configsvc] password_hash` to the output of `engined --hash-password` (it reads one line
from stdin) and the page asks for that password instead of a token. Five wrong tries a minute lock a client
out, and a session ends after 12 hours idle.

**From another machine.** Set `[configsvc] host` to the name or address clients dial and restart
`engined-tls`: the UI stays on loopback and Caddy serves `https://<host>:29444` in front of it, and the logged
URL is that one. Use `password_hash` there. Saving a config is root-equivalent (a `spec_dir` runs as root
through docker); [docs/security-model.md](docs/security-model.md) has the reasoning.

What each view does:

| View | What it does |
| --- | --- |
| Starter | Only while `config.toml` is absent or empty. Reads the host checks, the shipped engines (`engines/*/spec.toml`) and the weights already in each engine's default directory, lets you tick what to run and which files to serve, and fills the pending text with the result as a diff. |
| Overview | Where the file is, its hash, and the pending diff. |
| Engines | One card per engine: live state, disable, rename (a spec-keyed engine id is refused, with the reason), a delete guard listing what still points at it and its 7-day calls, container logs and resources, the read-only `spec.toml`, Obtain when the spec has artifacts. Its routes sit under it: a form that shows only the fields the engine kind allows, offers the upstreams the engine can use, suggests models and weight files (GGUF quantisation and context, with a warning when `ctx-size` exceeds it), checks each `args` entry as you type, shows the resolved upstream, capabilities and args, and has a Test button that sends one token through the route. |
| Upstreams | `base_url`, egress, wire, headers and the keyring reference. Present or missing is shown, the store form writes the value to the desktop keyring and never shows it again, a catalog fetch, the routes that use the upstream, and this month's reported spend against `monthly_cap_usd`. |
| Models | The `[[model]]` capability rows and the routes that inherit them. |
| Chains | Hops in order. Add hops… opens a dialog to filter addresses and add several at once; Select all visible ticks the ones on screen. Hops already on the chain are not offered, and neither is the chain itself. Other chains are listed as `@/<id>`, and choosing one inserts that chain's hops. A chain hop lists the addresses it inserts. The same dialog is on the Add wizard's chain path. A hop whose routes are all disabled, or a hop onto a disabled chain, is flagged as dropped. Hops can be reordered by drag or by the arrow buttons. |
| Address book | Every `@/...` address a consumer can use, with a copy button and 7-day calls. |
| Usage | Calls, failures and reported cost per route over 7 days. |
| Settings | The door's ports and timeouts, and `[configsvc]`. |
| Review & save | The diff against the file on disk, then Save. |
| History | The kept files (newest 20): diff one against the current file, or restore it. |
| Host checks | The `--doctor` report with the fix beside each failure. An agent whose engines are all disabled is skipped, as is bubblewrap when opencode is. A failure marks the sidebar link with a red exclamation. |
| Raw TOML | The pending text in an editor with TOML highlighting. Every change is validated the way engined loads it after a 300 ms pause; errors are marked at their line and column and listed under the editor. `config.d/` fragments are shown read-only. |
| About | The engined version this UI was built with, and the door's commit and contract when the door answers. |

Every form change edits the pending text through the same comment-preserving editor, so comments and layout
survive; nothing is written until Save. Any entry can be copied as TOML, and a pasted `[[table]]` snippet is
added only if the merged config validates.

**Saving.** Save writes with the hash the page read: if the file changed meanwhile you see that change and
choose between reloading from disk and saving yours over it. A save without a `[configsvc] enable` value writes
`enable = true` (untick it on Settings to turn the UI off). The result lists the engines whose container changes
and restarts on its next start. You then choose a hot reload (`HUP`) or a hard one (`USR1`, preselected when a
port moved), see [Signals](#signals-to-the-unit) below, and may name a route to test afterwards. The page waits
up to about 10 seconds for engined to report the saved config; if it does not, reports a `config_error`, or the
route test fails, it asks Keep or Revert. No answer keeps the change; Revert restores the file the save
replaced and reloads the same way.

`GET /engined/v1/engines` is the runtime operator surface — no `/v1/health`. The config UI above edits config; it adds nothing the door answers.

### Signals to the unit

`systemctl --user kill -s <SIG> engined.service`; `reload` sends HUP. The config UI's reload buttons send the first two:

| Signal | Reload | Keeps | Applies |
| --- | --- | --- | --- |
| `HUP` | hot | running containers, both ports | everything except `listen_port` and `cursor_port`; a changed port is refused and `config_error` names USR1 |
| `USR1` | hard | nothing: stops every container this process started, answers pending requests 503 | the whole config, including a moved `listen_port` or `cursor_port` |
| `TERM` | exit | nothing | stops every container, then exits |

Either reload also loads a config the daemon was waiting on.

`systemctl --user reload` re-reads `config.toml` and `config.d/`; in-flight
requests finish on the old engine list. A config the parser or the engine
registry rejects is not applied at all: the old one keeps serving and
`config_error` on `GET /engined/v1/engines` says why. The same response's
`config_sha256` identifies the text the running config came from, and
`config_error_sha256` the text of the failed attempt (recipe: `src/responses.ts`).
An accepted reload tears
down engines it no longer names (container, llama router, preset file) and
clears the synthesized-speech cache. A running container keeps its old shape
until next start (idle-stop or `POST /engined/v1/start`) — llama-server reads
presets INI once at startup. See [docs/configuration.md](docs/configuration.md).

An engine still running under a replaced config
generation reports a `superseded` field carrying the literal call that brings
it forward, and the door never acts on it by itself — restarting an engine
would reload whatever it had resident, up to ~30 GiB for llama, over an edit
that may not have named it.

```sh
curl -s localhost:29200/engined/v1/engines | jq '.engines[] | select(.superseded) | {id, superseded}'
```

`install.sh` also enables `engined-probe.timer`, which runs weekly and
re-checks the things a response cannot tell you itself: vision fidelity (see
[docs/engines.md](docs/engines.md#vision-fidelity-llama-vulkan)), that a
reranker still ranks the right document first, and that a transcription route
which has not declared `translate` still refuses to. Run it now:

```sh
systemctl --user start engined-probe.service
journalctl --user -u engined-probe -n 20
```

It sends a two-colour image through every vision address the model menu lists
and fails if the reply does not name both halves in order; a rerank query with
one answering document among three, and fails if that one is not ranked first;
and a translate request at every transcription route that did not declare
`translate`, failing if any answers instead of refusing. A box with none of
those configured gets one line saying so and a clean exit. That clean exit
proved nothing about vision fidelity. A configured vision route that is
unavailable fails the probe: the run asked it nothing, and a skip is not a
pass. A green vision line proves the synthetic image only — see
[docs/engines.md](docs/engines.md#vision-fidelity-llama-vulkan) for what it
does not cover, and re-check a consumer's real images before trusting the role.

An engine stops after `idle_stop_seconds` with no leases. Warm deliberately:

```sh
curl -s -X POST localhost:29200/engined/v1/start -H 'content-type: application/json' \
  -d '{"model":"@/llama/ornith"}' | jq
```

## Troubleshoot

| Symptom | Cause |
| --- | --- |
| `ECONNREFUSED` on 29200 | unit not running — `systemctl --user status engined` |
| exit 78 at startup | port already bound; the error names it |
| every route answers 503 | no valid config loaded; `config_error` on `GET /engined/v1/engines` says why. Fix the file, then `systemctl --user reload engined` |
| engine stuck `unavailable` | read its `fix` field and run that command |
| a 400 saying `unknown model` | bare model or engine id — every address needs `@/`, e.g. `@/<engine>/<model>` |
| a 400 listing qualified upstream forms | `@/<engine>/<model>` names a model two upstreams share on that engine — use `@/<engine>/<upstream>/<model>` |
| config change had no effect on a running engine | takes effect at the engine's next start — the engine's `superseded` field names the call that brings it forward now |
| an agentic engine refuses to serve | `agent_version` bumped; re-prove the read-only floor (cursor: `--mode ask`) |
| `opencode` refuses to serve | no `bwrap` on the box — the `fix` field says which |
| `engined-probe` failed with "reports no `vision` kind" | the running daemon predates the probe — re-run `scripts/install.sh` |
| `engined-probe` failed naming a reply | the vision role described the image wrongly — [docs/engines.md](docs/engines.md#vision-fidelity-llama-vulkan) |

## Uninstall

From the AUR: `systemctl --user disable --now engined engined-probe.timer
engined-tls.service engined-configsvc.service`, then `pacman -Rns engined` (or `engined-git`).

From a clone:

```sh
systemctl --user disable --now engined engined-probe.timer engined-tls.service engined-configsvc.service
rm ~/.config/systemd/user/engined.service ~/.config/systemd/user/engined-probe.* ~/.config/systemd/user/engined-tls.service ~/.config/systemd/user/engined-configsvc.service
systemctl --user daemon-reload
rm -rf ~/.local/share/engined
docker rm -f engined-tls
```

Stop and remove any remaining `engined-*` containers. Config
(`~/.config/engined/`) and the model tree (`~/.local/share/engined-models/`)
are not touched.

## Development

`bun test src` is the CI tier. `bun run test:local` needs real containers and
enough free memory for the suite's engine (the unit may stay up) — see [AGENTS.md](AGENTS.md).
