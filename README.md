<h1 align="center">engined</h1>

<div align="center">

[![ci](https://github.com/Rethunk-Tech/engined/actions/workflows/ci.yml/badge.svg)](https://github.com/Rethunk-Tech/engined/actions/workflows/ci.yml)
[![runtime: bun](https://img.shields.io/badge/runtime-bun%201.4-black)](https://bun.sh)
[![typescript](https://img.shields.io/badge/typescript-7.0-3178c6)](https://www.typescriptlang.org)
[![license: proprietary](https://img.shields.io/badge/license-proprietary-red)](LICENSE)

</div>

---

One local engine broker for the whole workstation.

engined is a `systemd --user` daemon that owns every inference engine on a box and serves them behind a single OpenAI-shaped door on loopback. Consumers send a `model` string; engined picks the engine, starts its container on demand, keeps one model resident per role, and stops it when idle.

## Quick start

```sh
bash scripts/install.sh && cp config.example.toml ~/.config/engined/config.toml
```

Edit the config, then `curl -s localhost:29200/engined/v1/engines` — runbook: **[HUMANS.md](HUMANS.md)**.

## Highlights

- **One door for five modalities** — chat, embeddings, speech, transcription,
  images.
- **Start on demand, stop when idle** — leases counted; idle 35B returns ~27 GiB.
- **One resident model per role** — occupancy is engined's job.
- **Chains with provenance** — fallback lists record which engine answered.
- **Agentic CLIs as an engine kind** — `claude` and `opencode`, both with
  writing disabled: claude by its own flags, opencode by a `bwrap` sandbox,
  because it has no flag that would do it.
- **Failures name their own fix** — literal `docker build` or `secret-tool store`.

## Documentation

| Document | Contents |
| --- | --- |
| [HUMANS.md](HUMANS.md) | Install, configure, verify, operate, uninstall |
| [AGENTS.md](AGENTS.md) | Test tiers, config/spec split, invariants |
| [docs/http-api.md](docs/http-api.md) | Routes, model spellings, chains |
| [docs/configuration.md](docs/configuration.md) | Schema, key set, args precedence |
| [docs/engines.md](docs/engines.md) | Per-engine images and occupancy |
| [docs/tuning.md](docs/tuning.md) | Speculative-decoding measurements |
| [docs/security-model.md](docs/security-model.md) | Origin check, agentic boundary |
| [docs/design.md](docs/design.md) | Ownership line, why 29200 |
| [CHANGELOG.md](CHANGELOG.md) | Unreleased changes |

## License

Copyright © Rethunk.Tech, LLC. All rights reserved. Proprietary and
confidential — see [LICENSE](LICENSE).
