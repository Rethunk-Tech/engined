# Security policy

## Reporting a vulnerability

Report privately through GitHub's
[security advisories](https://github.com/Rethunk-Tech/engined/security/advisories/new)
for this repository. Please do not open a public issue for a vulnerability.
Include the engined commit, the affected route or engine, and a reproduction.

## Scope

engined listens on loopback only and trusts the local user who runs it. What
it defends, and what it deliberately does not, is written down in
[docs/security-model.md](docs/security-model.md): the origin and Host check on
the door, the launch-scoped nonce for agentic hops, the write-disabled floor
for agent CLIs, and why docker-group access is root-equivalent.

In scope: anything that lets a request reach past those boundaries, such as
a browser origin driving the door, an agentic call changing a worktree, a
prompt or secret written to a log, or a `spec_dir` or config value escaping
its directory.

Out of scope: a local user who can already edit `config.toml`, the engine
specs, or the Docker daemon, since each of those is trusted by design.
