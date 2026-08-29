<h1 align="center">engined</h1>

<div align="center">

[![ci](https://github.com/Rethunk-Tech/engined/actions/workflows/ci.yml/badge.svg)](https://github.com/Rethunk-Tech/engined/actions/workflows/ci.yml)
[![runtime: bun](https://img.shields.io/badge/runtime-bun%201.3-black)](https://bun.sh)
[![typescript](https://img.shields.io/badge/typescript-7.0-3178c6)](https://www.typescriptlang.org)
[![license: proprietary](https://img.shields.io/badge/license-proprietary-red)](LICENSE)

</div>

---

One local engine broker for the whole workstation.

engined is a `systemd --user` daemon that owns every inference engine on a box
and serves them behind a single OpenAI-shaped door on loopback. Chat,
embeddings, speech and transcription all arrive at the same port; engined
decides which engine answers, starts its container on demand, keeps one model
resident per role, and stops it again when it goes idle.

The point is that nothing else has to. Consumers hold no provider keys,
supervise no servers and download no weights — they send a `model` string and
get a completion. Two projects on this box each started their own `llama.cpp`,
which is the collision this service exists to end.

## Quick start

```sh
bash scripts/install.sh && cp config.example.toml ~/.config/engined/config.toml
```

Then edit the config for your machine and check `curl -s
localhost:29200/v1/engines`. Prerequisites, the full install and the operator
runbook are in **[HUMANS.md](HUMANS.md)**.

## Highlights

- **One door for four modalities.** `/v1/chat/completions`, `/v1/embeddings`,
  `/v1/audio/speech` and `/v1/audio/transcriptions`, all OpenAI-shaped.
- **Start on demand, stop when idle.** Leases are counted, so an engine never
  stops mid-request — and a resident 35B model returns ~27 GiB to the pool
  when it does.
- **One resident model per role.** Occupancy is engined's job, not
  llama.cpp's: explicit same-role unload rather than a cross-role LRU.
- **Chains with provenance.** Name an ordered fallback list instead of a
  model; every call records which engine actually answered, and which GGUF.
- **Agentic CLIs as an engine kind.** `claude` is launched with writing
  structurally disabled and read through the same door as everything else.
- **Secrets stay in the keyring.** Resolved per request, so a unit that boots
  before the keyring unlocks recovers without a reload.
- **Failures name their own fix.** An engine that cannot run reports the
  literal `docker build` or `secret-tool store` command that resolves it.
- **Observable from outside.** engined holds the only docker access on the
  box, so it answers the questions nothing else can: `GET
  /v1/engines/<id>/logs`, `GET /v1/engines/<id>/resources`, and a live state
  stream at `GET /v1/engines/events` so a consumer learns about an idle-stop
  rather than discovering it on a failed call.
- **Graphics memory measured, not guessed.** Resources are read from inside
  each container, summing VRAM and GTT per DRM client. On a unified-memory
  APU neither number alone is the footprint, a cgroup reading misses the
  model entirely, and an unprivileged host-side read cannot see a container
  at all — the three ways to get this wrong.
- **Release without restarting.** `POST /v1/engines/<id>/release` drops a
  Comfy engine's weights and keeps the process, so freeing the GPU between
  phases does not cost a custom-node reload.

## Documentation

| Document | Contents |
| --- | --- |
| [HUMANS.md](HUMANS.md) | Install, configure, verify, operate, uninstall — the run/use surface |
| [AGENTS.md](AGENTS.md) | Test tiers, config/spec split, invariants that are easy to get wrong |
| [docs/http-api.md](docs/http-api.md) | Every route, the four `model` spellings, chains, provenance |
| [docs/configuration.md](docs/configuration.md) | Config schema, the closed key set, args precedence, secrets |
| [docs/engines.md](docs/engines.md) | Per-engine container images, occupancy, the vision caveat |
| [docs/tuning.md](docs/tuning.md) | Speculative-decoding measurements behind the shipped settings |
| [docs/security-model.md](docs/security-model.md) | Origin check, the agentic read-only boundary, sandbox limits |
| [docs/design.md](docs/design.md) | Ownership line, why 29200, what is deliberately not built |
| [TODO.md](TODO.md) | Outstanding work — currently empty |

## License

Copyright © Rethunk.Tech, LLC. All rights reserved. Proprietary and
confidential — see [LICENSE](LICENSE).
