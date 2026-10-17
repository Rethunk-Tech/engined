# Changelog

## Unreleased

### Config

- New `[configsvc]` table (`enable`, `host`, `port`, `password_hash`) for the config
  web UI. engined validates it (argon2id hash, port distinct from `listen_port`
  and `cursor_port`) and otherwise ignores it. `enable` defaults to false;
  `password_hash` is optional.
- `config.schema.json` is a JSON Schema of `config.toml`, generated from the
  parser's key sets (`bun run schema`); `config.example.toml` points at it with
  a `#:schema` directive for Taplo / Even Better TOML.

### Door

- `engined --doctor [--json]` checks the host (docker, `/dev/kfd` and `/dev/dri`,
  bwrap, each agent's binary, the keyring, the listen, cursor and config UI
  ports, each engine's `models_dir`) and prints one line per check with its fix.
  It exits 1 when a check fails and works without a valid config.
- `engined --configsvc-url` prints the URL the config UI unit last logged
  (`configsvc: <url>`), and says why when there is none. `engined --hash-password`
  reads one line from stdin and prints the argon2id hash for
  `[configsvc] password_hash`.

- `GET /engined/v1/engines` reports `config_sha256` (the config text the running
  config was loaded from) and, beside `config_error`, `config_error_sha256` (the
  text of the failed attempt).

- A config parse failure carries the path of what is at fault (file, table,
  entry index, key) beside its unchanged message, for tools that point at the
  field.

- A missing or invalid `config.toml` no longer exits 78 at startup. The door
  binds `listen_port` (read from the file when it can be, else 29200), answers
  503 with the error on every route, and reports it as `config_error` on
  `GET /engined/v1/engines`. A reload loads the config and brings it live.
  A port already in use still exits 78.
- `SIGUSR1` is a hard reload: it stops every container engined started,
  answers pending requests 503, reloads the config and rebinds `listen_port`
  and `cursor_port` when they changed. `SIGHUP` stays a hot reload and now
  refuses a port change, reporting `config_error` that names USR1.

## 0.1.1 - 2026-10-17

### Door

- A config file with a TOML syntax error is reported as
  `file:line:column: invalid TOML: <reason>`, at startup and in
  `config_error` after a failed reload, instead of a bare "invalid TOML".

## 0.1.0 - 2026-10-17

First public release.

### Door

- One OpenAI-shaped door on loopback for chat, embeddings, speech,
  transcription and images; consumers name a `model`, engined picks the engine.
- Engines start on demand, hold one resident model per role, and stop when
  idle. Chains fall back across engines and record which one answered.
- Fill-in-the-middle over llama.cpp's `/infill`, a vision bridge that captions
  an image for a text-only route, token counting from a GGUF's own vocabulary
  without loading weights, and per-day usage totals that keep no request
  content.
- `config.d/*.toml` fragments beside `config.toml`, picked up on reload, so a
  tool can add an engine and its routes for the length of a run and remove
  them after.
- `x-engined-queue-ms` on chat and completions: how long the call waited for
  a llama slot, separate from how long it took.
- A streamed llama answer whose caller stops reading is cut after
  `stream_stall_seconds` (default 60) so it cannot hold a slot forever; a
  slow model never trips it.
- Remote upstreams with keyring-held secrets, egress ceilings and extra
  request headers.

### Agentic engines

- `claude`, `opencode` and `cursor` as engines, each with writing disabled and
  a floor probe that re-proves it on every version change.

### Engines

- Shipped images for llama.cpp, whisper.cpp, ComfyUI, Chatterbox, Kokoro and
  Piper, optimised for AMD Strix Halo; any engine can point at another image
  through `spec_dir`.

### Packaging

- AUR packages `engined` (release tag) and `engined-git` (main). Both install
  to `/usr/lib/engined` with the `systemd --user` units in
  `/usr/lib/systemd/user`; `ENGINED_INSTALL_DIR` tells the daemon where.

### Licence

- MIT. Upstream projects and models are credited in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
