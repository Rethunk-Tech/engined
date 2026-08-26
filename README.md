<h1 align="center">engined</h1>

<div align="center">

One local engine broker for the whole workstation.

</div>

---

**Nothing is built yet.** This repository holds a design only. `TODO.md` is the
decision ledger.

`engined` owns LLM engine configuration, selection, OpenAI-compatible
invocation, llama.cpp occupancy, and container lifecycle for every product on
this machine. Consumers send an OpenAI-compatible chat request; `engined`
selects the engine, runs it, and returns the answer plus a provenance record.
Consumers own no engine config, no container lifecycle, and no keyring code.
They keep their own adapters and product prompts.

Agentic spawn (`claude -p`, `cursor-agent`) and the git write-guard live in
`project-register`, not here.

The CLI client is `engine`.

Local-only: loopback TCP (and a unix socket for systemd activation), no
authentication, no tenancy. `engined` knows nothing about the task — changing
a feature's prompt must not require an `engined` change.
