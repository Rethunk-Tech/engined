<h1 align="center">engined</h1>

<div align="center">

One local engine broker for the whole workstation.

</div>

---

`TODO.md` is the scope, one entry per feature, and is authoritative;
`PHASES.md` is the order to build them in; `docs/migrations/` holds one cutover
guide per consumer. This file says only what the service is.

`config.example.toml` is a worked, committed configuration covering every
engine this repo ships a spec for. Copy it to
`$XDG_CONFIG_HOME/engined/config.toml` and edit it for your machine — it is
kept parsing against the real config loader by `src/config-example.test.ts`,
so it is never stale.

`engined` owns LLM engine configuration, engine selection and invocation for
every product on this machine. Consumers send an OpenAI-shaped request naming a
model or a chain; `engined` decides which engine serves it, runs it, and returns
the answer with a provenance record. Consumers own no engine list, no container
lifecycle and no keyring code.

Agentic CLIs are an engine *kind*, not a separate API: they are launched with
writing structurally disabled, so they read a repository and return text like
any other completion. `engined` never writes to a caller's worktree.

Local-only: loopback TCP, no authentication, no tenancy.
