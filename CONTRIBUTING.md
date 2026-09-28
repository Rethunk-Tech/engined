# Contributing

## Setup

```bash
bun install
lefthook install
```

`lefthook` and `gitleaks` must be on `PATH`: the pre-commit hook runs
gitleaks, and the pre-push hook runs `bun install --frozen-lockfile && bun
run ci`.

## Workflow

1. Make a change under `src/` (or an `engines/<id>/` spec or Dockerfile).
2. Run [`gate`](https://github.com/Rethunk-Tech/rethunk-gate-cli) before
   committing. It is build, typecheck, lint, test and actionlint; `bun run ci` is the same minus actionlint, and is what the
   pre-push hook runs.
3. Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, ...).
4. Open a PR against `main` using the PR template.

## Testing

Three tiers, described in [AGENTS.md](AGENTS.md#testing): unit tests under
`src/*.test.ts` that need nothing installed and run in `gate`, the pre-push
hook and CI; a local tier under `test/local/*.test.ts` that needs real
containers and never runs in CI; and no mocks in either.

## Documentation

[README.md](README.md) orients, [HUMANS.md](HUMANS.md) is the runbook,
[AGENTS.md](AGENTS.md) holds the test tiers, the config and spec split and the
invariants, and [docs/](docs/) is the reference.
