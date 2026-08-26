<h1 align="center">engined</h1>

<div align="center">

One local engine broker for the whole workstation.

</div>

---

**Nothing is built yet.** This repository holds a design only. `TODO.md` is the
decision ledger.

`engined` owns LLM engine configuration, engine selection, invocation, container
lifecycle, and the write guard around agentic invocation, for every product on
this machine. Consumers send a prompt (or an OpenAI-compatible chat request);
`engined` selects the engine, runs it, and returns the answer plus a provenance
record. Consumers own no engine config, no container lifecycle, and no keyring
code. They keep their own adapters and product prompts.

The CLI client is `engine`.

Local-only: loopback TCP (and a unix socket for systemd activation), no
authentication, no tenancy. `engined` knows nothing about the *task* — changing
a feature's prompt must not require an `engined` change. `workdir` and
`targets[]` on `/v1/agent` are guard inputs, not task semantics.
