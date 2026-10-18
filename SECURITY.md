# Security policy

Report privately via
[security advisories](https://github.com/Rethunk-Tech/engined/security/advisories/new).
Do not open a public issue. Include the commit, affected route or engine, and a reproduction.

Boundaries, origin/Host check, agentic floor, and docker-group equivalence:
[docs/security-model.md](docs/security-model.md).

In scope: a request that crosses those boundaries (browser origin driving the door, an agentic call changing a worktree, a prompt or secret in a log, `spec_dir` or config escaping its directory).

Out of scope: a local user who can already edit `config.toml`, engine specs, or the Docker daemon — trusted by design.
