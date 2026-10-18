# Changelog

## Unreleased

- whisper: no hardcoded `-t 16`; `threads` in `[engine.args]` sets the thread count on both the server
  and the streaming path, and whisper.cpp's own default applies when it is unset.
- whisper: the model is the route's `filename` alone. Only the weights an enabled route names have to
  be on disk, a start that names no model loads the first route's file, and the spec lists the q5
  quantisations (`small.en-q5_1`, `medium.en-q5_0`, `large-v3-turbo-q5_0`) with their obtain
  commands. A spec marks such weights `route_file = true` on their `[[artifact]]`.
- llama: `models_max` may be below the number of roles; roles then share that many resident models,
  a cold role evicting the least recently used idle one. It may not be below the number of
  `keep_resident` roles.
- Config: a disabled route no longer counts toward the roles `models_max` must cover.
- Config UI: chain hops offer every model in an enabled wildcard route's cached catalog, and a hop
  onto a catalog model reads as served rather than "matches no route".

## 0.2.4 - 2026-10-17

- Config: a disabled route, or any route on a disabled engine or upstream, may name a `filename`
  that is not on disk yet. engined and the config UI no longer refuse the whole config over weights
  nothing will load.

## 0.2.3 - 2026-10-17

- Config UI: the Map tints chains, engines and upstreams in their own colours, with a legend that
  also shows what a disabled entry looks like.
- Config UI: an upstream no route uses says so on its tile and card, with how to give it one: an
  upstream alone serves no models.
- Config UI: an Add wizard, opened beside each Add box, connects a hosted provider in one pass
  (upstream, key into the keyring, engine and routes, with presets for OpenAI, OpenRouter, Google AI,
  Anthropic, Groq, Mistral and DeepSeek), adds a shipped local engine, or builds a chain from its
  hops. Chain hops no longer offer a wildcard route, which is a catalog rather than one model.

## 0.2.2 - 2026-10-17

- Config UI: every engine says what it is and links to its project, on its tile, its card and in
  the starter wizard. A spec declares this with `description` and `homepage` (an https URL); every
  shipped spec carries both.
- Config UI: kinds read in plain words ("text to speech", not `tts`); engine state and upstream egress
  are icons; disabled engines show as disabled rather than unavailable; a tile whose weights are missing
  links straight to Obtain. Shipped engines not yet in the config can be added from a list, an engine
  with many routes gets a filter, the logs panel follows new lines, and Usage covers 7 or 31 days.
- Config UI: delete and rename open as modals instead of growing the card header; field help is shown
  in full; one route form is open at a time; the Overview counts disabled engines as disabled.
- Config UI: a Map view draws the pending config as a Mermaid flowchart: chains, engines grouped by
  kind, and upstreams grouped by how far a call travels (this box, local network, internet), with
  disabled entries dashed. It fills the window and pans, zooms, fits and copies its Mermaid source.
  Mermaid loads only when the Map opens: the build now splits chunks, so the other views load what
  they did before.
- Config UI: a route's Test sends the request that route serves (speech, transcription, embeddings,
  rerank, completions), not always a chat request; image routes say they have no cheap test.
- Config UI: on a first run, the "cannot read config" error from before any save no longer marks the
  first save and reload as failed.

## 0.2.1 - 2026-10-17

- Config UI: each llama engine card shows estimated resident memory (GGUF size plus KV cache at the
  route's ctx-size and cache types), the largest on-demand model, and the box's total and
  available memory, with a warning when they do not fit; the route form shows the per-route estimate.
  On a hybrid model only the full-attention layers (and MTP layers) count toward the KV cache.
- Config UI: the raw editor marks validation problems inline, the starter wizard's default
  proposal always validates, and checkboxes sit beside their labels.
- TLS bridge: Caddy's admin API is off. With the bridge on host networking it sat on the host's
  127.0.0.1:2019, and nothing reloads Caddy through it.
- `--prune-config` removes its scratch discovery directory when it finishes or refuses.
- Release: `.deb` and `.rpm` packages for x64 and arm64 are attached to each GitHub release. They
  ship a standalone binary, so they need no bun.

## 0.2.0 - 2026-10-17

### Config

- New `[configsvc]` table (`enable`, `host`, `port`, `password_hash`) for the config
  web UI. engined validates it (argon2id hash, port distinct from `listen_port`
  and `cursor_port`) and otherwise ignores it. `enable` defaults to false;
  `password_hash` is optional.
- `config.schema.json` is a JSON Schema of `config.toml`, generated from the
  parser's key sets (`bun run schema`); `config.example.toml` points at it with
  a `#:schema` directive for Taplo / Even Better TOML.

### Door

- `engined --configsvc` runs a config web UI (Preact; shell with sign-in, a
  saved-versus-running banner and a pending-changes diff so far) for the `engined-configsvc` unit: read, validate, edit with
  comments kept, diff and save `config.toml` with history and an audit line,
  reload engined, and see its status, models, secrets and host checks. Sign-in
  is a token logged at each start or `[configsvc] password_hash`.
- `[configsvc] host` is now the name clients dial, not a bind address: the UI always listens on
  loopback, and a non-loopback host gets an HTTPS site (`:29444`) in the `engined-tls` Caddyfile, which
  `engined --caddyfile TEMPLATE OUT` renders before Caddy starts. The UI accepts that bridged `Host`
  with an https `Origin`, marks its cookie `Secure`, and logs the https URL. `0.0.0.0` is refused.
- `bun run test:e2e` (also `gate --e2e`) runs one Chromium smoke of the config UI: every view renders
  without a script error, a route field edit shows its diff, saves one changed line and
  hot-reloads a scratch door.
- `GET /api/shipped` lists the shipped engines with their default weights directory contents.
- Editing a config that lacks a table no longer fails on the first `addEntry` to it.
- `GET /api/history/:name` returns one kept file. `GET /api/logs/:engine`, `GET /api/resources/:engine` and `POST /api/dependents` join the config UI's API.
- The build is `bun build --outdir=dist`: `dist/main.js` plus the config UI's hashed assets
  and `dist/configsvc/ui/index.html`. The installer, the release tarball and both AUR
  packages ship all of `dist/`; `--configsvc` changes its working directory to the
  bundle's, where Bun looks for those assets.
- `scripts/install.sh` installs, enables and restarts `engined-configsvc.service` (also on a box with no config, where it prints `engined --configsvc-url` as the next step), sandboxed
  like the daemon with only `~/.config/engined` writable.
- Releases attach a prebuilt `engined-<version>.tar.gz`; the AUR `engined` package
  installs from it instead of building.
- `POST /engined/v1/upstreams/:id/refresh` fetches that upstream's model list
  now.

- `POST /engined/v1/engines/:id/obtain` runs the engine spec's missing `[[artifact]]`
  obtain commands and streams their output as SSE (`step`, `line`, then `exit`
  events). 404 when the spec declares none, 409 while one is already running.
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
