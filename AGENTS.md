# engined

Contributor map. `README.md` orients; `HUMANS.md` is the runbook. This file
covers test tiers, the config/spec split, and invariants. `TODO.md` is
currently empty.

Implementation: `src/`, Bun and TypeScript. Acceptance criteria and engine
traps live beside the code they govern.

## Testing

Three tiers:

- `src/*.test.ts` — CI: parse, dispatch, chain-advance, provenance against a
  fake upstream. Nothing installed.
- `test/local/*.test.ts` — `ENGINED_LOCAL=1`, serial against real containers.
  Never in CI. **Stop the unit first:** `systemctl --user stop engined.service`.
  Run as `bun run test:local` (not by pointing `bun` at the directory).
- No mocks — traps are tool behaviour; substitutes are injected functions with
  real defaults and recorded output.

Guards with failing tests: one container start under concurrent load; one llama
owner under cross-role load; port-in-use exits 78; Comfy diffusion through a
real checkpoint when weights are present.

Shipped images are migrated from the fleet (gfx1151, ROCm/Vulkan, never CUDA),
never invented.

## Config vs spec

`config.example.toml` is the committed reference — kept honest by
`src/config-example.test.ts` calling `loadConfig()`. Update it in the same
change as `src/config.ts` or any `spec.toml` drift.

An engine engined **launches** is `engines/<id>/` (`spec.toml`, Dockerfile,
mounted files). `config.toml` names it and supplies install-specific values.
Remote-only engines stay wholly in config: `base_url`, `secret`, `egress`.

Spec-shipped details that fail silently when dropped (Comfy preview method,
kokoro entrypoint, whisper `--inference-path`, agentic read-only flags) belong
in spec, not operator config. Tunables go in `[engine.args]` / `[model.args]`;
engined's closed key set is `ENGINE_KEYS` in `src/config.ts`. Precedence:
**model beats engine, config beats spec, floor beats everything.** On remotes,
`[engine.args]` are wire parameters — see `src/remote.ts`.

| Entry | Required | Absent by construction |
| ------ | ------ | ------ |
| `[[model]]` on llama | `id`, `engine`, `filename`, `role` | — |
| `[[model]]` on agentic | `id`, `engine` | `filename`, `role` |
| `[[engine]]`, every kind | `id`, `egress` | — |
| `[[engine]]`, remote only | `id`, `egress`, `base_url`, `secret` | `spec_dir`, `models_dir`, `models_max` |

Origin/Host check, browser callers, and why `cursor-agent` did not ship:
[docs/security-model.md](docs/security-model.md).

## Invariants

**No port is written down for anything engined starts** except the door and a
remote `base_url`. Host ports come from Docker; container side from `EXPOSE`.

**Agentic guarantee is integrity, not confidentiality.** An agentic call cannot
change a worktree; it can read anything this uid can open.

**No door logs a prompt.** The provenance line is the only per-call record and
carries no request content; an agentic child's stderr is dropped, never
forwarded. See [docs/security-model.md](docs/security-model.md).

**The unit's read-only sandbox does not survive docker.** `docker run` writes as
root; docker-group access is root-equivalent. A `spec_dir` override is a
privilege decision — spec is trusted code. See `scripts/engined.service.in`.

Before committing: `gate` (build, typecheck, lint, test, actionlint).

Do not cut consumers over until engined can replace what they run today.
`Rethunk-Tech/project-register` is off limits.
