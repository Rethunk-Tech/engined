# Running engined

Everything needed to install, configure, operate and remove engined on a
workstation. Deep reference lives under [`docs/`](docs/) and is linked from
each section rather than repeated here.

| Topic | Canon |
| --- | --- |
| Every route, model spelling, chain behaviour | [docs/http-api.md](docs/http-api.md) |
| Config schema, key set, args precedence, secrets | [docs/configuration.md](docs/configuration.md) |
| Per-engine images, occupancy, vision caveat | [docs/engines.md](docs/engines.md) |
| Speculative-decoding measurements | [docs/tuning.md](docs/tuning.md) |
| Origin check, agentic read-only boundary, sandbox limits | [docs/security-model.md](docs/security-model.md) |

## Prerequisites

- Linux with `systemd --user`
- Docker, with your user in the `docker` group
- [Bun](https://bun.sh) on `PATH` (or `ENGINED_BUNX` set)
- `secret-tool` (libsecret) for any engine that needs a key
- For GPU engines on this box: AMD Strix Halo / gfx1151, ROCm 7.2+

## Quick start

```sh
bash scripts/install.sh
cp config.example.toml ~/.config/engined/config.toml
$EDITOR ~/.config/engined/config.toml
curl -s localhost:29200/v1/engines | jq
```

## Install

```sh
bash scripts/install.sh
```

Builds a single-file bundle, syncs `engines/` into `~/.local/share/engined/`
(`$XDG_DATA_HOME/engined/` when that is set), renders the `systemd --user`
unit at `~/.config/systemd/user/engined.service`, then enables and restarts
it. Enabled means it comes back at the next login on its own; `loginctl
enable-linger` on top of that is what keeps it up with nobody logged in.

Running it again **is** the update. There is no other install or update path,
and nothing reachable over HTTP writes to the install directory.

**Never run it under `sudo`.** Root-owned outputs break every later
user-level build, `git` and `scp`.

The sync uses `rsync --delete`, which is why the model tree is a sibling of
the install directory rather than inside it — see
[docs/configuration.md § Paths](docs/configuration.md).

## Configure

```sh
cp config.example.toml ~/.config/engined/config.toml
$EDITOR ~/.config/engined/config.toml
```

Edit it for your machine: which engines you have images for, which GGUFs you
downloaded, which `claude_version` you have proved. A config naming a file
that is not on disk, or an engine whose spec directory is not installed, fails
loudly at parse rather than starting broken.

Secrets are stored in the keyring, never in the config:

```sh
secret-tool store --label='elevenlabs-api' service elevenlabs-api username scribe
```

The full schema — the closed key set, which keys are required for which entry
shape, args precedence — is [docs/configuration.md](docs/configuration.md).

## Verify

```sh
curl -s localhost:29200/v1/engines | jq '.engines[] | {id, state, fix}'
```

Every engine should read `installed` (ready, not running), `running`, or
`unavailable` **with a `fix` naming the literal command** that resolves it —
`docker pull …`, `docker build …`, or a `secret-tool store` line.

Then send one real request:

```sh
curl -s localhost:29200/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"chain-private","messages":[{"role":"user","content":"say OK"}],"max_tokens":16}'
```

The first call to a stopped engine starts its container and waits for
readiness, so it is slower than the rest.

## Operate

```sh
curl -s localhost:29200/v1/engines | jq     # state, and the fix for anything unavailable
journalctl --user -u engined -f             # one JSON line per call
systemctl --user reload engined             # re-read config.toml
systemctl --user restart engined            # full restart
```

`GET /v1/engines` is the whole operator surface — there is no `/v1/health` and
no web UI. A running engine also reports `active_leases`, the requests holding
it open right now, which is how a caller waiting on an engine that serializes
internally becomes visible.

### Reload

`systemctl --user reload` sends `SIGHUP`, which re-reads `config.toml`.
In-flight requests finish against the old engine list and new ones see the
new list. A new or changed `[[model]]`,
`[engine.args]`, or a changed spec's `image`/devices/`models_max` does **not**
reach a *running* container: llama-server reads its presets INI once, at its
own startup, so an engine keeps serving its old shape until it next starts —
idle-stop, or an explicit `POST /v1/engines/:id/start`.

### Idle-stop

An engine stops once nothing has held it for `idle_stop_seconds`. Leases are
counted, so the countdown cannot fire mid-request, and it is armed on start as
well as on release — an engine warmed by `POST /v1/engines/:id/start` and
never dispatched to still stops on its own.

Measured on this box: a resident 35B GGUF returns ~27 GiB to the shared pool
when its engine idles out.

### Warm an engine deliberately

```sh
curl -s -X POST localhost:29200/v1/engines/local-llama/start | jq
```

Returns the engine's `private_url`. Comfy is reached this way and then talked
to directly — engined manages its container lifecycle but proxies nothing for
it.

## Troubleshoot

| Symptom | Cause |
| --- | --- |
| `ECONNREFUSED` on 29200 | unit not running — `systemctl --user status engined` |
| exit 78 at startup | the port was already bound; the error names the port. It deliberately does not name the holder: `ss -p` cannot resolve a pid across the unit's mount namespace |
| engine stuck `unavailable` | read its `fix` field and run that command |
| a 400 listing qualified forms | a bare model id that two engines both serve — use `@/<engine>/<model>` |
| config change had no effect on a running engine | see Reload above; it takes effect at the engine's next start |
| an agentic engine refuses to serve | `claude_version` was bumped and the read-only floor has not been re-proved for the new pin |

## Uninstall

There is no uninstall script. Removal is three steps:

```sh
systemctl --user disable --now engined
rm ~/.config/systemd/user/engined.service && systemctl --user daemon-reload
rm -rf ~/.local/share/engined
```

Containers this daemon started are named `engined-*`; stop and remove any that
remain. Your config (`~/.config/engined/`) and your model tree
(`~/.local/share/engined-models/`) are deliberately **not** touched — the
model tree is tens of gigabytes that nothing would replace.

## Development

`bun test src` is the CI tier and needs nothing installed. The local tier
(`bun run test:local`) drives real containers and requires the unit to be
stopped first. See [AGENTS.md](AGENTS.md) for both.
