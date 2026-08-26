<h1 align="center">engined</h1>

<div align="center">

One local engine broker for the whole workstation.

</div>

---

**Nothing is built yet.** This repository holds a design only. `TODO.md` is the
decision ledger and is authoritative; this file says only what the service is.

`engined` owns LLM engine configuration, engine selection and invocation for
every product on this machine. Consumers send an OpenAI-shaped request naming a
model or a chain; `engined` decides which engine serves it, runs it, and returns
the answer with a provenance record. Consumers own no engine list, no container
lifecycle and no keyring code.

Agentic CLIs are an engine *kind*, not a separate API: they are launched with
writing structurally disabled, so they read a repository and return text like
any other completion. `engined` never writes to a caller's worktree.

Local-only: loopback TCP, no authentication, no tenancy.
