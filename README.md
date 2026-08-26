<h1 align="center">engined</h1>

<div align="center">

One local engine broker for the whole workstation.

</div>

---

**Nothing is built yet.** This repository holds a design only. `TODO.md` is the
decision ledger.

`engined` owns LLM engine configuration, engine selection, invocation, and the
write guard around agentic invocation, for every product on this machine.
Consumers describe a task; `engined` decides which engine runs it, runs it, and
returns the answer plus a provenance record. Consumers own no engine config, no
fallback logic, no container lifecycle and no keyring code.

The CLI client is `engine`.

Local-only: a unix socket, no TCP listener, no authentication, no tenancy.
