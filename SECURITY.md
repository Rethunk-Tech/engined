# Security

## Supported versions

The default branch (`main`) and the latest release. Fixes land there; there is no long-lived release branch to backport to.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: <https://github.com/Rethunk-Tech/engined/security/advisories/new>, or the **Security** tab, then **Report a vulnerability**. The report stays private between you and us until a fix ships.

If private reporting is unavailable, email [oss@rethunk.tech](mailto:oss@rethunk.tech) with **[SECURITY]** in the subject.

Please do not open a public issue, pull request or discussion for a suspected vulnerability.

A useful report has the commit, the affected route or engine, steps to reproduce, what an attacker gets and under which conditions, and whether anyone else knows.

## What counts as a vulnerability

A vulnerability is a flaw that lets someone cross a boundary they should not: run code, read or change data they have no right to, escape a sandbox or path restriction, or leak a credential. A bug is anything else that misbehaves, such as a crash on your own input, wrong output or a slow path; open an ordinary issue for those. If you are unsure which one you have, report it privately and we will say.

## Coordinated disclosure

We handle the report inside the private advisory, so you see each status change and can comment on the fix. The advisory goes public when the fix ships, or 90 days after your report, whichever comes first. If a fix is close, either of us can ask for more time in the thread. You are credited in the advisory unless you would rather not be.

## Response timelines

- We acknowledge your report within 3 business days.
- We give you an assessment (accepted, needs more information or declined, with reasons) within 10 business days.
- We aim to ship a fix within 90 days of the report.

## What is in scope

A request that crosses the boundaries described in [docs/security-model.md](docs/security-model.md) (origin and Host checks, the agentic floor, docker-group equivalence): a browser origin driving the door, an agentic call changing a worktree, a prompt or secret in a log, `spec_dir` or config escaping its directory.

## What is out of scope

A local user who can already edit `config.toml`, engine specs or the Docker daemon; they are trusted by design.

## Safe harbour

We will not pursue legal action against good-faith research that avoids privacy violations, data destruction and disruption of services, stops at a proof of concept, and keeps the details private until the advisory is published. Rethunk.Tech, LLC maintains this repository.
