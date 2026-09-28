<h1 align="center">engined</h1>

<div align="center">

[![ci](https://github.com/Rethunk-Tech/engined/actions/workflows/ci.yml/badge.svg)](https://github.com/Rethunk-Tech/engined/actions/workflows/ci.yml)
[![runtime: bun](https://img.shields.io/badge/runtime-bun%201.4-black)](https://bun.sh)
[![typescript](https://img.shields.io/badge/typescript-7.0-3178c6)](https://www.typescriptlang.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

One local engine broker for the whole workstation.

engined is a `systemd --user` daemon that owns every inference engine on a box and serves them behind a single OpenAI-shaped door on loopback. Consumers send a `model` string; engined picks the engine, starts its container on demand, keeps one model resident per role, and stops it when idle.

## Requirements

- git, [Bun](https://bun.sh) 1.4, Docker, and rsync.
- The shipped engine images are **optimised for AMD Strix Halo** (Ryzen AI
  Max, gfx1151): ROCm 7.2 for the PyTorch engines, RADV Vulkan for llama.cpp
  and whisper.cpp. Other hardware works by pointing an engine at your own image:
  one `spec_dir = "..."` line on its `[[engine]]` in `config.toml`, naming a
  spec whose `image` suits your GPU or CPU. See
  [docs/configuration.md](docs/configuration.md) and
  [docs/engines.md](docs/engines.md).

## Quick start

```sh
git clone https://github.com/Rethunk-Tech/engined.git
cd engined
bash scripts/install.sh
mkdir -p ~/.config/engined
cp config.example.toml ~/.config/engined/config.toml
systemctl --user restart engined.service
```

Engine images are built locally on first use; edit the config, then `curl -s localhost:29200/engined/v1/engines`. Runbook: **[HUMANS.md](HUMANS.md)**.

## Highlights

- **One door for five modalities** — chat, embeddings, speech, transcription,
  images.
- **Start on demand, stop when idle** — leases counted; idle 35B returns ~27 GiB.
- **One resident model per role** — occupancy is engined's job.
- **Chains with provenance** — fallback lists record which engine answered.
- **Agentic CLIs as an engine kind** — `claude`, `opencode`, and `cursor`,
  writing disabled: claude and cursor by their own flags, opencode by a
  `bwrap` sandbox, because it has no flag that would do it.
- **Fill-in-the-middle** — `POST /openai/v1/completions` over llama's own `/infill`, for a route that opts in.
- **Vision bridge** — a text-only chat route can take an image attachment by
  captioning it through a vision route first.
- **Per-day usage totals** — `GET /engined/v1/usage` sums provenance without
  keeping request content.
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
| [CHANGELOG.md](CHANGELOG.md) | Release notes |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Upstream projects, models, and their licences |

## License

MIT, see [LICENSE](LICENSE). Third-party projects engined builds on, fetches, or
borrows from are credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
