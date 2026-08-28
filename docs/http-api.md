# HTTP API

Loopback TCP on **`29200`**, bound on both loopback families. No
authentication, no tenancy, no TLS — it is local-only. `listen_port`
overrides the port.

Every request is origin-checked first, on every endpoint including reads: a
foreign `Origin`, an `Origin: null`, or a `Host` outside
`{127.0.0.1, localhost, [::1]}` at the configured port is refused. A request
carrying no `Origin` is served normally, which covers every CLI and server
consumer. See [security-model.md](security-model.md) for why a browser is
treated as a caller.

## Routes

| Route | Method | Answered by |
| --- | --- | --- |
| `/v1/chat/completions` | POST | `openai-http`, `agentic-cli` |
| `/v1/embeddings` | POST | `openai-http` |
| `/v1/audio/speech` | POST | `tts` |
| `/v1/audio/transcriptions` | POST | `stt` |
| `/v1/models` | GET | every dispatchable `model` string |
| `/v1/engines` | GET | engine list, state, and the fix for anything unavailable |
| `/v1/engines/:id/start` | POST | warms one engine, returns its `private_url` |

`/tokenize`, `/detokenize`, `/apply-template`, `/slots`, `/slots/:id`,
`/models/load` and `/models/unload` proxy through to the one local llama
engine, with the resident chat model injected where the body omits one.

## Choosing a model

The OpenAI `model` field accepts four spellings:

| Form | Example | Notes |
| --- | --- | --- |
| bare id or alias | `ornith` | only when exactly one engine serves it; two or more is a 400 listing the qualified forms |
| engine id | `chatterbox` | for kinds that take no separate model (`agentic-cli`, `tts`, `stt`) |
| chain name | `chain-private` | an ordered fallback list |
| qualified | `@/local-llama/ornith` | canonical, and the only form a chain hop may use |

The `@/` prefix exists because the obvious spelling collides with reality: a
Hugging Face id is already `org/model`, and a GGUF filename is the same
shape, so a bare `engine/model` cannot be told apart from a repo name. `@/`
is what makes the namespace unambiguous without banning slashes from either
side.

## Chains

A chain is an ordered list a consumer names instead of one model. It advances
on a 5xx or an empty body and stops on a 4xx — a caller's own bad request is
not something a second engine can fix.

`chain-private` is one hop on purpose: it is the name a consumer points at to
say *this prompt does not leave the box*, and keeping it a chain means adding
a second local engine later is a config edit rather than a consumer change.

A chain hop may leave the machine, and provenance is why that is allowed at
all. A hop that cannot say which engine answered is not auditable, and an
unauditable egress is not one this design accepts.

## Engine state

`GET /v1/engines` is the whole operator surface. Each engine reports its
`state`, its `private_url` when running, and — when it cannot run —
`unavailable` plus the literal command that fixes it: `docker pull …`,
`docker build …`, or a `secret-tool store` line for a missing key.

A running engine also reports `active_leases`: the requests holding it open
right now. The audio engines serialize every request on one process-wide lock
inside the container, so a second caller simply waits; this count is how that
wait becomes visible from outside.

## Provenance

Every call writes one structured JSON line to journald:

```json
{"chain":"chain-private","requested":"chain-private","attempts":[{"engine":"local-llama","model":"ornith","ok":true,"duration_ms":9203,"model_reported":"ornith","model_resident":"ornith"}],"engine_used":"local-llama"}
```

`model_reported` is the id the engine echoed in its body; `model_resident` is
read from that engine's own `GET /v1/models`. They answer different questions
— one proves the request reached the engine, the other names the GGUF that
actually served it — and one silently standing in for the other defeats the
point.

A streamed call's line is deferred until the stream ends, so a mid-body
disconnect lands as that attempt's failure rather than vanishing.
