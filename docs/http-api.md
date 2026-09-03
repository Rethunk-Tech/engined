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
| `/openai/v1/chat/completions` | POST | `openai-http`, `agentic-cli` |
| `/openai/v1/embeddings` | POST | `openai-http` |
| `/openai/v1/audio/speech` | POST | `tts`; `"stream": true` returns PCM as it is synthesized, `"stream": "ndjson"` the engine's own frames with synthesis progress, and on each `chunk` frame the `words` it carries (`{text, start, end}` in seconds from the start of the utterance; every shipped engine reports them: kokoro and piper from their own phoneme timings, chatterbox by forced alignment of what it produced). `voice`, `speed` and `instructions` reach the engine under its own names; any other field is forwarded untouched |
| `/openai/v1/audio/transcriptions` | POST | `stt` |
| `/openai/v1/models` | GET | every dispatchable address, as a row — see [Choosing a model](#choosing-a-model) |
| `/engined/v1/audio/voices` | POST | multipart `file`: stores one voice-clone reference and answers `{voice, bytes}`, the handle a later `/audio/speech` names — see [Cloning a voice](#cloning-a-voice) |
| `/engined/v1/engines` | GET | engine list, state, and the fix for anything unavailable |
| `/engined/v1/start` | POST | warms the route(s) an address or chain name resolves to; each row's `started` says whether this call launched it |
| `/engined/v1/engines/:id/stop` | POST | stops one engine now, rather than waiting out idle-stop |
| `/engined/v1/engines/:id/release` | POST | drops the weights but leaves the container up (comfy only) |
| `/engined/v1/engines/:id/logs` | GET | `docker logs --tail` for a container-backed engine |
| `/engined/v1/engines/:id/resources` | GET | what a running container holds, read from inside it |
| `/engined/v1/engines/events` | GET | SSE: a snapshot, then every engine state change as it happens |

`/engined/v1/engines/:id/tokenize` and `/engined/v1/engines/:id/apply-template`
proxy through to the named llama engine, with the resident chat model injected
where the body omits one. Any other engine id is refused with a 400 naming it
unknown — they are llama.cpp routes, not a general engine surface, and that is
true of every kind that is not llama, not only ids that never existed.

`/openai/v1/audio/transcriptions` forwards `language`, `response_format` and
`prompt` to the engine. `prompt` is whisper's initial prompt: a short list of
vocabulary the caller expects to hear, which is the only lever that moves a
proper noun the model has never seen. The remote STT dialect has no equivalent,
so it is dropped there rather than translated.

A `stream=true` form field on that verb answers in NDJSON instead: one
`{"phase":"segment", "text", "start", "end"}` frame per segment as the model
decodes it, then a terminal `{"phase":"done", "text"}` carrying the whole
transcript, or `{"phase":"error", "detail"}`. The frames are the engine's own
intermediate output, and hanging up mid-body stops the decode rather than
leaving it running. `response_format` names a whole-transcript format, so
asking for `srt`/`vtt`/`text` alongside `stream` is a 400 rather than a
silently ignored field, and the remote STT dialect refuses to stream for the
same reason it drops `prompt`: it has no equivalent.

A form cannot carry a recording that is still being made -- a multipart part is
only readable once the boundary after it has arrived, so the door holds the
whole upload before the engine sees a byte of it. The live shape is the same
verb with `?stream=true` and the audio as the request body:

```
record | curl -sN --no-buffer -X POST -T - -H 'Content-Type: audio/wav' \
  'http://127.0.0.1:29200/openai/v1/audio/transcriptions?stream=true&model=@/whisper/medium.en'
```

`-T -` rather than `--data-binary @-`, which reads all of stdin before it sends
anything and so streams nothing.

`model`, `language`, `prompt` and `response_format` ride in the query string,
and the reply is the same NDJSON. The engine decodes what has arrived rather
than waiting for the end of it: fed at 1x realtime, a 20.09s recording's first
frame lands 4.59s in, against 0.95s *after* the upload finishes for the same
audio sent as a form. Sub-second uploads gain nothing from it -- there is
nothing to decode ahead of -- and a body that is not a WAV has no sample
boundaries to cut windows on, so it streams no intermediate frames either way.

The `segment` frames on a live body are provisional: a decode of the first four
seconds of a sentence is not a decode of the sentence, and each pass holds back
the phrase its window cut in half rather than emitting a fragment nothing
completes. The `done` frame is not provisional. It is the buffered verb's own
answer to the completed upload, produced by the handler that answers it, so a
streamed transcript and a buffered one are the same string -- identical byte
for byte over 15 clips from 2.4s to 41.6s, where matching the two decodes by
flags alone left 6 of them disagreeing.

### Cloning a voice

A `tts` engine that clones (both chatterbox images) conditions on a reference
recording, and a container reads only what the door mounted into it — so the
reference is uploaded, never named:

```
curl -F file=@reference.wav http://127.0.0.1:29200/engined/v1/audio/voices
{"voice":"vc_cef8305b2eb7c0bf8766de6b1f5d0fab.wav","bytes":176684}
```

Send that `voice` back on `POST /openai/v1/audio/speech` and the door turns it
into the path it chose, under the read-only mount the engine's spec declares.
The handle is the only thing a caller ever holds: a `vc_` string the door did
not issue is refused with a 400 rather than reaching an engine, and a `voice`
that is not a handle — a voice name, or a path baked into an engine image —
is forwarded untouched, so an engine that cannot resolve it still answers 502
naming the path rather than quietly speaking in the wrong voice.

The store keeps the 64 least-recently-spoken-with references, 16 MB each at
most; a handle that has fallen off the end is refused, and re-uploading the
file issues a new one.

`/openai/v1/` carries the OpenAI-compatible endpoints and `/engined/v1/` this
door's own. `/anthropic/v1/` is reserved for an Anthropic-shaped surface and
serves nothing today: an unclaimed prefix 404s like any other unmatched path.

## Choosing a model

An engine has no address of its own — `[[upstream]]` carries `base_url`,
`secret` and `egress`, and an address always names a route, never a bare
engine or a bare model id. A caller absent or empty on `model` is a 400 rather
than defaulted, because a request that has not said where a prompt should run
has not said whether it may leave the machine. The OpenAI `model` field takes
one of four spellings:

| Form | Example | Meaning |
| --- | --- | --- |
| `@/model` | `@/ornith` | the highest-preference route offering that model, ordered local → `lan` → `remote` → declaration. Does not walk on failure — a caller wanting fallback writes a chain |
| `@/engine/model` | `@/llama/ornith` | upstream defaults by the engine's trait: ambient for an `optional`-upstream engine, `local` for `self`, its single upstream for `required` (an error if it has more than one) |
| `@/engine/upstream/model` | `@/llama/local/ornith` | fully explicit — the only form a chain hop may use |
| `@/engine/upstream` | `@/comfy/local` | a **modelless** engine, whose routes declare no `model`. This is its only form: there is no one-segment address for it, and a third segment is a parse error because there is no model to name |
| chain name | `chain-private` | an ordered fallback list |

A bare model id or a bare engine id (no `@/`) is not a valid `model` value —
an unqualified string resolves only as a chain name, and anything else is a
400 naming it unknown.

The `@/` prefix exists because the obvious spelling collides with reality: a
Hugging Face id is already `org/model`, and a GGUF filename is the same
shape, so a bare `engine/model` cannot be told apart from a repo name — and a
route's `wire_model` (the id its upstream actually knows, sent on the wire in
`model`'s place, for exactly the case where that id itself contains a slash)
makes this doubly true today: the address grammar and the wire id are
deliberately different strings so one plain segment separator can serve both.
`@/` is what makes the namespace unambiguous without banning slashes from
either side.

`GET /openai/v1/models` reports one row per address inside the surviving
OpenAI `{"object":"list","data":[...]}` envelope — never a bare id. Each row
is `{id, engine, upstream, model, egress, streaming, tools, serves, state,
capabilities}`, plus `hops` on every chain and `unavailable_hops` on a chain
that has any.

`hops` is where a chain says what it resolves to, and the only place it can:
a chain is not any one engine's route, so `engine`, `upstream`, `model` and
`egress` are all absent from its row. It carries the hop addresses in order,
and it is present on exactly the chain rows -- a route row never has it, so
its presence is also what tells the two kinds of address apart. Without it a
healthy chain is the least informative row in the menu, since
`unavailable_hops` is absent precisely when nothing is broken; with it, a
caller can see that `chain-private` and `@/llama/ornith` are one destination
listed twice rather than two models.

`serves` is the route's own, not its engine's: an `embedding`
role answers only `/openai/v1/embeddings`, any other role everything but that,
and a route with no role whatever its engine serves -- so `@/llama/embed` is
never offered as a chat model, and a chat request to it is a 400. The same
per-route `serves` rides on each entry of an engine's `capabilities[]` in
`GET /engined/v1/engines`.

A chain row omits `engine`/`upstream`/`model`/`egress` because
no single one answers for every hop, and reports `streaming` and
`capabilities` off its first hop instead -- the hop a request starts on.
`streaming` is the engine spec's answer unless the route itself declares one.

`state` on a chain answers "can I send this a request", not "is every hop
healthy". A chain advances past a hop it cannot reach, so it is usable as
long as one hop is: `state` is the first hop that can answer, and
`state: "installed"` therefore means *some* hop can answer -- possibly not
the first. `unavailable_hops` is the other half of that answer: the hop
addresses that cannot, each for the reason a direct row to it would give --
an engine that is not installed, or an upstream whose address or secret does
not resolve. It is absent when every hop can answer, and absent on every
non-chain row. When it lists every hop of the chain, nothing can answer and
`state` reads `unavailable`.

## Chains

A chain is an ordered list a consumer names instead of one model. It advances
on a 5xx, an empty body, or a 401/402/403/429 — those four are credential- and
rate-shaped, not the caller's fault, so a sibling engine gets a turn. Every
other 4xx still stops the chain: a caller's own bad request is not something a
second engine can fix.

`chain-private` is one hop on purpose: it is the name a consumer points at to
say *this prompt does not leave the box*, and keeping it a chain means adding
a second local engine later is a config edit rather than a consumer change.

A chain hop may leave the machine, and provenance is why that is allowed at
all. A hop that cannot say which engine answered is not auditable, and an
unauditable egress is not one this design accepts.

## Engine state

`GET /engined/v1/engines` is the whole operator surface. Each engine reports its
`state` and — when it cannot run — `unavailable` plus the literal command that
fixes it: `docker pull …`, `docker build …`, or a `secret-tool store` line for
a missing key. There is no `private_url` on this wire: where a managed
container happens to listen is the door's own business, never a caller's —
see [comfy](#comfy) below for what that means for the one engine with an
API of its own.

The response carries a `contract` number, bumped when a field is **removed**,
a state renamed, or a route's meaning altered — never for a field added. A
consumer that ignores fields it does not know keeps working across an
addition, so bumping for one would spend the signal that tells it when
something it already reads has changed underneath it.

An engine, upstream, route or chain carrying `disable = true`
([configuration.md](configuration.md#turning-something-off)) is listed here
too, carrying `disabled: true` and `state: "unavailable"`. Nothing was probed
to establish that state -- no docker call, no keyring lookup, no version proof
-- and its `fix` is the config edit that turns it back on. It is listed rather
than omitted because "turned off here" and "gone from the config" are
different answers to an operator staring at this route. An address naming a
disabled engine is a 400 on `POST /engined/v1/start` and on every dispatch
endpoint, and `GET /openai/v1/models` does not advertise it.

A running engine also reports `active_leases`: the requests holding it open
right now. The audio engines serialize every request on one process-wide lock
inside the container, so a second caller simply waits; this count is how that
wait becomes visible from outside.

`POST /openai/v1/audio/speech` buffers by default and returns a complete `audio/wav`.
With `"stream": true` it returns `audio/L16; rate=<engine's own rate>;
channels=1` — signed 16-bit little-endian mono, forwarded as each piece is
synthesized. PCM rather than a WAV because a WAV header carries a length
nothing knows until synthesis ends; the rate and encoding ride in the content
type instead.

**Read the rate off the content type of the reply you got.** It
is not the same for every engine — kokoro synthesizes at 24000 and piper's
voice at 22050 — and a caller that assumes one plays the other 8.8% fast and
sharp. A mid-stream failure ends the stream rather than changing a status code
that has already been sent, so a caller sees short audio.

Only an engine that implements chunking can be streamed: kokoro and piper do,
and chatterbox-multi and chatterbox-en do not — a single blocking `generate()` has
no piece to forward before the last one. A request that streams one of those
gets a 502 saying the engine streamed no audio, sent before any header is
committed, rather than a 200 whose body never arrives.

**Ask, rather than hardcoding that list.** Every engine in
`GET /engined/v1/engines` carries `streaming`, a boolean saying whether it can serve a
streamed request -- chunked audio from a `tts` app, per-segment transcript
frames from `whisper`, SSE from an `openai-http` server, deltas from an agent
CLI's streamed output format -- declared in the engine's own `spec.toml` (see
[engines.md](engines.md)) and overridable per route. A consumer carrying its
own list of streaming engine ids is stale the moment engined gains one.
`comfy` reports `false`: its proxy is not a content endpoint. A remote-address
TTS or STT engine reports `false` — engined ships no remote dialect to stream
through.

An agentic hop with `"stream": true` is one `chat.completion.chunk` per text
delta the CLI prints, a terminal chunk with `finish_reason: "stop"`, then
`data: [DONE]`. The stream is only committed to once the CLI has printed
answer text: a refusal before that (missing `workdir`, a failed floor or
secret, an envelope that fails before its first delta) is still a plain
status, and a CLI that fails after its first delta ends the stream with an
error rather than a stop.

**How much this buys depends on the text.** Kokoro's pipeline splits on
newlines, not sentences: measured here, four newline-separated lines produced
four chunks of 1.7–2.0s each, while a single five-sentence paragraph produced
one chunk of 18.68s and therefore streams no earlier than buffering would. A
caller that wants early audio should send its text newline-separated. Making
the engine split on sentences instead would change how it reads across
sentence boundaries, so it is not done here. Piper splits on sentences itself,
so its chunk boundaries follow the text's punctuation and need nothing from
the caller.

`POST /engined/v1/start` takes `{ "model": "<address or chain name>" }` — an
engine id is not a place, so there is no per-engine sibling of this route. A
chain name warms its first hop only: warming exists to avoid a cold first
turn, and starting every hop would spin up containers for requests the first
hop is going to answer. A bare `@/<model>` address warms every route offering
that model, since one address can name more than one engine there; the two-
and three-segment forms are already engine-specific and warm exactly one.

Response rows are `{address, engine, upstream, state, started, fix?}` — never
a `url`: reaching an engine is a separate request to the door, by address,
and this verb only answers what state it is in. `started` is `true` only when
this call is the one that launched the engine, `false` when it was already
running -- the field a caller polling for "is it warming" can read once
instead of hitting `/openai/v1/models` on a loop.

On a llama route this loads the named
GGUF, so the first real request does not pay the cold load -- measured at
13.84s cold against 2.09s warm for a TTS round trip on this box. The warm goes
through the ordinary lease, so it cannot jump the queue or hold a role against
anyone; it is released immediately and idle-stop is armed as usual. It is a
head start, not a pin. `keep_resident` in [configuration.md](configuration.md)
is what makes residency survive.

A llama engine additionally reports `roles`, one entry per role that is doing
something: `{ role, active, waiting }`. These are not the same number as
`active_leases` and answer a different question -- that one counts the whole
container, this one counts a single role's occupancy, where `waiting` is the
requests queued behind a resident model that has to be swapped out before
theirs can load. It is the difference between "the model is still loading" and
"three requests are ahead of you", which `state` alone cannot express. A role
with nothing running and nothing queued is omitted rather than reported as
zero, and a kind with no roles carries no `roles` at all.

## Comfy

Comfy is a **modelless** engine, addressed only as `@/comfy/local`, with no
one-segment or three-segment form. It is reached entirely through a mediated
proxy under `/engined/v1/comfy/:engine/:upstream/...`, never at a raw
container address: every real caller's `object_info`, `prompt`, `upload/image`,
`view`, `ws`, `history/:promptId` and `queue` calls forward through this door,
by address, resolved to the running container's own host:port on the door's
side only. This is what keeps every control this project has -- call
recording, egress ceilings, and later a budget -- in one place: a consumer
holding a raw container address routes around all of it, so none is ever
handed out.

`GET /view` and `POST /queue` are mediated against what this door has actually
seen pass through the proxy -- the `prompt_id`s `POST /prompt` returned and the
output filenames a completed `/history` read surfaced for them -- rather than
against anything a caller merely claims, since Comfy's output directory is
shared and a caller-supplied filename must never become a URL on its own say-so.

`POST /cancel` is the door's own verb rather than a forwarded one, and the
reason comfy's `/interrupt` is never forwarded at all: `/interrupt` stops
whatever the container is currently processing and carries no id to scope it.
A caller sends `{"prompt_id": "<id>"}` — an id this door bound through
`POST /prompt`, or the call is a 404 — and the door reads the container's queue
itself, never handing that ledger out, to decide what to do with it. A success
is `{prompt_id, cancelled}`, where `cancelled` reports what the container
actually did rather than what was asked of it; anything the container refused
is a 502 carrying comfy's own status, never a `cancelled` the door did not
perform.

| Reply | Meaning |
| --- | --- |
| 200 `{"cancelled": "running"}` | the prompt was the one executing, and it was interrupted |
| 200 `{"cancelled": "pending"}` | it was still queued, and was dropped without an interrupt |
| 200 `{"cancelled": "finished"}` | there was nothing left to stop, and nothing was sent |
| 502 `comfy queue could not be read` | the queue did not answer as one, so nothing was proven and nothing sent |
| 502 `comfy refused to interrupt "<id>" (http <status>)` | the prompt was the running one and is running still |
| 502 `comfy refused to drop "<id>" from its queue (http <status>)` | the prompt was pending and is queued still |

The distinction is what a caller polling `/history` needs to read next — only a
`running` cancel truncates work already done. Two windows stay open, each one
round trip wide, because the queue read and the act on it are separate calls: a
prompt that finishes between them sends the interrupt to whichever job
inherited the GPU, and one that starts rendering between them is reported
`pending` while it holds the GPU, since comfy answers 200 to a queue delete
that removed nothing.

The binding table those verbs read is bounded by **count**, not age: the door
keeps the most recent 1000 `prompt_id` bindings across every comfy engine and
caller, in memory and on disk, evicting oldest-first past that. A binding
survives a door restart and expires only by being pushed out by 1000 newer
prompts, however recent it is in wall-clock terms. Past that point `GET /view`
refuses an output this door itself produced, and `/cancel` and `POST /queue`
404 an id they once knew — so a consumer holding output filenames for later
should fetch them while they are still within that window rather than treat an
old filename as a durable URL.

## Provenance

Every call writes one structured JSON line to journald:

```json
{"chain":"chain-private","requested":"chain-private","attempts":[{"engine":"llama","model":"ornith","ok":true,"duration_ms":9203,"model_reported":"ornith","model_resident":"ornith"}],"engine_used":"llama"}
```

`model_reported` is the id the engine echoed in its body; `model_resident` is
read from that engine's own `GET /openai/v1/models`. They answer different questions
— one proves the request reached the engine, the other names the GGUF that
actually served it — and one silently standing in for the other defeats the
point.

A streamed call's line is deferred until the stream ends, so a mid-body
disconnect lands as that attempt's failure rather than vanishing.
