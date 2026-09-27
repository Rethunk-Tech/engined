# Running engined

Install, configure, operate and remove engined on a workstation. Deep reference
is under [`docs/`](docs/) and linked from [README.md](README.md).

## Prerequisites

- Linux with `systemd --user`
- Docker, with your user in the `docker` group
- [Bun](https://bun.sh) on `PATH` (or `ENGINED_BUNX` set)
- `secret-tool` (libsecret) for any engine that needs a key
- For GPU engines on this box: AMD Strix Halo / gfx1151, ROCm 7.2+

## Install

```sh
bash scripts/install.sh
```

Builds a bundle, syncs `engines/` into `~/.local/share/engined/`
(`$XDG_DATA_HOME/engined/` when set), renders the `systemd --user` unit, then
enables and restarts it. Running it again **is** the update — nothing over HTTP
writes to the install directory.

**Never run it under `sudo`.** Root-owned outputs break later user-level builds.

The sync uses `rsync --delete`; the model tree is a sibling of the install
directory — [docs/configuration.md § Paths](docs/configuration.md).

## Configure

```sh
cp config.example.toml ~/.config/engined/config.toml
$EDITOR ~/.config/engined/config.toml
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

`GET /engined/v1/engines` is the operator surface — no `/v1/health`, no web UI.

`systemctl --user reload` re-reads `config.toml`; in-flight requests finish on
the old engine list. A running container keeps its old shape until next start
(idle-stop or `POST /engined/v1/start`) — llama-server reads presets INI
once at startup. See [docs/configuration.md](docs/configuration.md).

That is no longer silent: an engine still running under a replaced config
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
those configured gets one line saying so and a clean exit.

An engine stops after `idle_stop_seconds` with no leases. Warm deliberately:

```sh
curl -s -X POST localhost:29200/engined/v1/start -H 'content-type: application/json' \
  -d '{"model":"@/llama/ornith"}' | jq
```

## Troubleshoot

| Symptom | Cause |
| --- | --- |
| `ECONNREFUSED` on 29200 | unit not running — `systemctl --user status engined` |
| exit 78 at startup | port already bound; error names the port |
| engine stuck `unavailable` | read its `fix` field and run that command |
| a 400 saying `unknown model` | bare model or engine id — every address needs `@/`, e.g. `@/<engine>/<model>` |
| a 400 listing qualified upstream forms | `@/<engine>/<model>` names a model two upstreams share on that engine — use `@/<engine>/<upstream>/<model>` |
| config change had no effect on a running engine | takes effect at the engine's next start — the engine's `superseded` field names the call that brings it forward now |
| an agentic engine refuses to serve | `agent_version` bumped; re-prove the read-only floor |
| `opencode` refuses to serve | no `bwrap` on the box — the `fix` field says which |
| `engined-probe` failed with "reports no `role`" | the running daemon predates the probe — re-run `scripts/install.sh` |
| `engined-probe` failed naming a reply | the vision role described the image wrongly — [docs/engines.md](docs/engines.md#vision-fidelity-llama-vulkan) |

## Uninstall

```sh
systemctl --user disable --now engined engined-probe.timer
rm ~/.config/systemd/user/engined.service ~/.config/systemd/user/engined-probe.*
systemctl --user daemon-reload
rm -rf ~/.local/share/engined
```

Stop and remove any remaining `engined-*` containers. Config
(`~/.config/engined/`) and the model tree (`~/.local/share/engined-models/`)
are not touched.

## Development

`bun test src` is the CI tier. `bun run test:local` needs real containers and
the unit stopped first — see [AGENTS.md](AGENTS.md).
