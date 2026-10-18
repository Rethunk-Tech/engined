# Contributing

## Setup

```bash
bun install
lefthook install
```

`lefthook` and `gitleaks` must be on `PATH`: the pre-commit hook runs
gitleaks, and the pre-push hook runs `bun install --frozen-lockfile && gate`.

## Workflow

1. Make a change under `src/` (or an `engines/<id>/` spec or Dockerfile).
2. Run [`gate`](https://github.com/Rethunk-Tech/rethunk-gate-cli) before
   committing. It is build, typecheck, lint, test, actionlint and shellcheck.
   `bun run ci` is the four bun tasks through turbo. The pre-push hook runs
   `gate` after a frozen-lockfile install. CI runs the same six steps.
3. Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, ...).
4. Open a PR against `main` using the PR template.

## Testing

Three tiers plus an opt-in browser smoke, described in
[AGENTS.md](AGENTS.md#testing): unit tests under `src/*.test.ts` that need
nothing installed and run in `gate`, the pre-push hook and CI; a local tier
under `test/local/*.test.ts` that needs real containers and never runs in CI;
an opt-in Playwright smoke under `e2e/` (`gate --e2e` or `bun run test:e2e`);
and no mocks in either required tier.

## Documentation

[README.md](README.md) orients, [HUMANS.md](HUMANS.md) is the runbook,
[AGENTS.md](AGENTS.md) holds the test tiers, the config and spec split and the
invariants, and [docs/](docs/) is the reference.
