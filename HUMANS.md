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

Full schema: [docs/configuration.md](docs/configuration.md).

## Verify

```sh
curl -s localhost:29200/v1/engines | jq '.engines[] | {id, state, fix}'
```

Every engine should be `installed`, `running`, or `unavailable` **with a `fix`**
naming the literal command to resolve it. Then one real request:

```sh
curl -s localhost:29200/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"chain-private","messages":[{"role":"user","content":"say OK"}],"max_tokens":16}'
```

The first call to a stopped engine starts its container and waits for readiness.

## Operate

```sh
curl -s localhost:29200/v1/engines | jq     # state and fix for unavailable
journalctl --user -u engined -f             # one JSON line per call
systemctl --user reload engined             # re-read config.toml
systemctl --user restart engined            # full restart
```

`GET /v1/engines` is the operator surface — no `/v1/health`, no web UI.

`systemctl --user reload` re-reads `config.toml`; in-flight requests finish on
the old engine list. A running container keeps its old shape until next start
(idle-stop or `POST /v1/engines/:id/start`) — llama-server reads presets INI
once at startup. See [docs/configuration.md](docs/configuration.md).

An engine stops after `idle_stop_seconds` with no leases. Warm deliberately:

```sh
curl -s -X POST localhost:29200/v1/engines/local-llama/start | jq
```

## Troubleshoot

| Symptom | Cause |
| --- | --- |
| `ECONNREFUSED` on 29200 | unit not running — `systemctl --user status engined` |
| exit 78 at startup | port already bound; error names the port |
| engine stuck `unavailable` | read its `fix` field and run that command |
| a 400 listing qualified forms | bare model id served by two engines — use `@/<engine>/<model>` |
| config change had no effect on a running engine | takes effect at the engine's next start |
| an agentic engine refuses to serve | `agent_version` bumped; re-prove the read-only floor |
| `opencode` refuses to serve | no `bwrap` on the box, or no `agent_model` on the engine — the `fix` field says which |

## Uninstall

```sh
systemctl --user disable --now engined
rm ~/.config/systemd/user/engined.service && systemctl --user daemon-reload
rm -rf ~/.local/share/engined
```

Stop and remove any remaining `engined-*` containers. Config
(`~/.config/engined/`) and the model tree (`~/.local/share/engined-models/`)
are not touched.

## Development

`bun test src` is the CI tier. `bun run test:local` needs real containers and
the unit stopped first — see [AGENTS.md](AGENTS.md).
