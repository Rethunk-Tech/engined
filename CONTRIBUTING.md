# Contributing

## Setup

```bash
bun install
lefthook install
```

## Workflow

1. Make a change under `src/` (or an `engines/<id>/` spec/Dockerfile).
2. `gate` (or `bun run ci`) locally before opening a PR.
3. Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, ...).
4. Open a PR against `main` using the PR template.

## Testing

Three tiers, described in [AGENTS.md](AGENTS.md#testing): CI-only unit tests
under `src/*.test.ts`, a local tier under `test/local/*.test.ts` that needs
real containers and is never run in CI, and no mocks in either.

## Documentation

See [AGENTS.md](AGENTS.md) for the file-by-file map and invariants.
