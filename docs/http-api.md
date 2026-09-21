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
| `/openai/v1/rerank` | POST | `openai-http`: `{model, query, documents}` in, `{results:[{index, relevance_score}]}` out — see [Rerank](#rerank) |
| `/openai/v1/audio/speech` | POST | `tts`; `"stream": true` returns PCM as it is synthesized, `"stream": "ndjson"` the engine's own frames with synthesis progress, and on each `chunk` frame the `words` it carries (`{text, start, end}` in seconds from the start of the utterance; every shipped engine reports them: kokoro and piper from their own phoneme timings, chatterbox by forced alignment of what it produced). `voice`, `speed` and `instructions` reach the engine under its own names; any other field is forwarded untouched |
| `/openai/v1/audio/transcriptions` | POST | `stt` |
| `/openai/v1/audio/translations` | POST | `stt`, and only a route declaring `translate` — same upload, rendered as English. See [Translations](#translations) |
| `/openai/v1/images/generations` | POST | `comfy`: `{prompt, size, n, negative_prompt, seed}` in, `{created, data:[{b64_json}]}` out — see [Images](#images) |
| `/openai/v1/images/edits` | POST | `comfy`: multipart `image` + `prompt`, the same render started from the caller's own image — see [Editing an image](#editing-an-image) |
| `/openai/v1/models` | GET | every dispatchable address, as a row — see [Choosing a model](#choosing-a-model) |
| `/engined/v1/audio/voices` | POST | multipart `file`: stores one voice-clone reference and answers `{voice, bytes}`, the handle a later `/audio/speech` names — see [Cloning a voice](#cloning-a-voice) |
| `/engined/v1/engines` | GET | engine list, state, and the fix for anything unavailable |
| `/engined/v1/start` | POST | warms the route(s) an address or chain name resolves to; each row's `started` says whether this call launched it |
| `/engined/v1/engines/:id/stop` | POST | stops one engine now, rather than waiting out idle-stop |
| `/engined/v1/engines/:id/release` | POST | drops the weights but leaves the container up (comfy only) |
| `/engined/v1/engines/:id/hold` | POST | stops the engine and keeps it stopped, so another process can load the same weights without racing this door for the pool. `?seconds=` (default 1800, max 3600) is a TTL, not a lock: a holder that dies releases it by lapsing. Re-holding extends. A start refuses while it stands |
| `/engined/v1/engines/:id/unhold` | POST | ends a hold early rather than waiting out its TTL |
| `/engined/v1/engines/:id/logs` | GET | `docker logs --tail` for a container-backed engine |
| `/engined/v1/engines/:id/resources` | GET | what a running container holds, read from inside it |
| `/engined/v1/engines/events` | GET | SSE: a snapshot, then every engine state change as it happens — snapshot and live frames carry the same `roles[]` as `GET /engined/v1/engines` |

`/engined/v1/engines/:id/tokenize` and `/engined/v1/engines/:id/apply-template`
proxy through to the named llama engine. If no chat model is resident, the
door warms the engine's local chat route (`keep_resident` when one is pinned)
before injecting that model where the body omits one. Any other engine id is refused with a 400 naming it
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
| chain name | `chain-private` | an ordered fallback list — chat, speech and transcription |

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

A remote `openai-http` route with `model = "*"` expands from that provider's
`/models` list. Each provider id becomes an address segment by replacing
`/` with `%2F` and nothing else; the reverse is what the hop sends as
`wire_model`. `@/engine/*` is a 400 — the sentinel is not a served id. A
declared alias that already claims the same `wire_model` is listed once, as
the alias. Empty or expired inventory adds no discovered rows.
`GET /engined/v1/engines` `capabilities[]` stays the declared routes; expansion
lives only on this menu.

`GET /openai/v1/models` reports one row per address inside the surviving
OpenAI `{"object":"list","data":[...]}` envelope — never a bare id. Each row
is `{id, engine, upstream, model, egress, streaming, tools, serves, role, vision, state,
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

`serves` is the route's own, not its engine's: a role that claims a path
answers only that path (`embedding` answers `/openai/v1/embeddings`, `rerank`
answers `/openai/v1/rerank`), a role that claims none answers everything no
other role claims, and a route with no role whatever its engine serves -- so
`@/llama/embed` is never offered as a chat model, and a chat request to it is
a 400. The same
per-route `serves` rides on each entry of an engine's `capabilities[]` in
`GET /engined/v1/engines`.

`role` is the route's inference role, and the only field that tells a vision
address from a chat one: both serve `/openai/v1/chat/completions`, so `serves`
separates the roles that claim a path of their own from everything else and
nothing more. It is
absent on a route that declares none, and on a chain row for the same reason
`engine` is. It rides on each `capabilities[]` entry in
`GET /engined/v1/engines` too.

`vision` splits the vision role in two, and is present on every vision row and
no other:
`"describe"` names a model that reads a scene back in prose, `"read"` one that
recognises the characters printed in an image. They serve the same path and
declare the same capabilities, so this is the only thing a consumer can pick
on — see [configuration.md](configuration.md).

A chain row omits `engine`/`upstream`/`model`/`egress` because
no single one answers for every hop, and reports `streaming` and
`capabilities` off its first hop instead -- the hop a request starts on.
`streaming` is the engine spec's answer unless the route itself declares one.

`state` on a chain answers "can I send this a request", not "is every hop
healthy":

- A chain advances past a hop it cannot reach, so it is usable as long as one
  hop is: `state` is the first hop that can answer, and `state: "installed"`
  therefore means *some* hop can answer -- possibly not the first.
- `unavailable_hops` is the other half of that answer: the hop addresses that
  cannot, each for the reason a direct row to it would give -- an engine that
  is not installed, or an upstream whose address or secret does not resolve.
- It is absent when every hop can answer, and absent on every non-chain row.
- When it lists every hop of the chain, nothing can answer and `state` reads
  `unavailable`.

## Chains

A chain is an ordered list a consumer names instead of one model. It advances
on a 5xx, an empty body, or a 401/402/403/429 — those four are credential- and
rate-shaped, not the caller's fault, so a sibling engine gets a turn. Every
other 4xx still stops the chain: a caller's own bad request is not something a
second engine can fix.

### Which endpoints take one

`/chat/completions`, `/audio/speech` and `/audio/transcriptions`. Embeddings do
not: a vector from a second engine is not comparable with the first's, so
falling back would answer with something the caller cannot use against what it
already stored.

Hops are not pre-checked against the endpoint. A hop that does not serve it
fails as itself and the next one is tried, so a chain of chat engines posted to
`/audio/speech` comes back with each hop's own reason rather than one sentence
about the chain.

**A recording streamed as the request body cannot use a chain.** The upload *is*
the request, and the first hop consumes it; a second hop would be handed a
drained body and would transcribe silence while reporting success. That is
refused with a 400 naming the fix — send the recording as a multipart upload,
whose bytes can be replayed. A buffered transcription and every speech request
chain normally.

A chain across audio engines records one provenance line carrying every hop,
the same as a chat chain.

`chain-private` is one hop on purpose: it is the name a consumer points at to
say *this prompt does not leave the box*, and keeping it a chain means adding
a second local engine later is a config edit rather than a consumer change.

A chain hop may leave the machine, and provenance is why that is allowed at
all. A hop that cannot say which engine answered is not auditable, and an
unauditable egress is not one this design accepts.

## Engine state

`GET /engined/v1/engines` is the whole operator surface. A running engine also
reports `superseded` when its container was started under a config generation
`reload` has since replaced — the value is the literal call that brings it
forward, and nothing acts on it automatically, because restarting an engine
reloads whatever it had resident over an edit that may not have named it. It is
absent on anything not running, and on a running engine still on the config in
force.

Each engine reports its
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

## Translations

`POST /openai/v1/audio/translations` is the transcriptions verb with one field
added: whisper renders the speech as English instead of in the language it was
spoken. Same multipart upload, same `prompt` and `response_format`.

Which routes answer it is a property of the weights, not of the engine. An
English-only model handed the translate flag does not fail — it transcribes,
and returns something that reads like a translation. So a route declares
`translate = true` in config, and one that does not **does not serve this
path**: the refusal is a 400 naming the address, before any audio is decoded.

```sh
curl -s localhost:29200/openai/v1/audio/translations \
  --form-string model=@/whisper/large-v3-turbo -F file=@clip.wav
```

`--form-string` for the model, not `-F`: an address begins `@/`, which `-F`
reads as "upload this file". Only `file=@clip.wav` wants that.

**A fluent answer is not a correct one.** Measured on large-v3-turbo-q8_0:
Spanish for "the black cat sleeps on the wooden table in the kitchen"
transcribed character for character, and translated as "The black man sleeps
on the bed in the kitchen" -- the same recording, heard perfectly, rendered
wrong. Check this verb against speech you understand before wiring a consumer
to it.

`@/whisper/medium.en` on that same call is a 400 saying it does not serve the
endpoint — it is English-only, and the config says so.

No `language` field: translation targets English, and the source language is
whisper's own to detect. No streaming either — the wrapper's streaming route
carries `language` and `prompt` and has no channel for this field, so a
streamed translation would arrive as a plain transcript. `stream=true` here is
a 400 rather than a silently untranslated answer.

## Rerank

`POST /openai/v1/rerank` scores a caller's own documents against one query,
which is the second stage of a retrieval pipeline whose first stage is
`/openai/v1/embeddings`. It reaches a `role = "rerank"` route the same way
every other model-routed verb reaches its own: the body's `model` string, an
`@/engine/model` address like any other.

```sh
curl -s localhost:29200/openai/v1/rerank -H 'content-type: application/json' \
  -d '{"model":"@/llama/rerank","query":"what is a broker",
       "documents":["a broker routes requests","bananas are yellow"]}'
```

```json
{"results": [{"index": 0, "relevance_score": 2.5e-06},
             {"index": 1, "relevance_score": 1.3e-07}]}
```

Results come back **ordered best-first**, and `index` is into the array as
sent -- so the caller maps them onto its own list rather than trusting the
text to come back unchanged. Scores are the engine's own and carry no fixed
scale: they order documents *within one response* and mean nothing compared
across calls, models, or engines. Measured on Qwen3-Reranker-0.6B-seq-cls,
one relevant document among three scored 0.907 against 7.8e-11 and 4.9e-11,
so the separation is wide rather than marginal.

On llama the model must be a **sequence-classification** conversion
(`-seq-cls`): llama.cpp reranks through a rank head the stock Qwen3-Reranker
export does not carry.

The body is forwarded to the engine untouched past `model`, so any field that
engine reads reaches it. Chains do not serve this verb — a chain name here is
a 400 naming the endpoint, the same answer embeddings gives.

A rerank route is one resident GGUF on its own role, so a reranker, an
embedder and a chat model are all resident at once without evicting each
other. On llama that role needs `rerank = true` in its `[route.args]`; without
it the child answers 501 naming the flag it was started without.

## Images

`POST /openai/v1/images/generations` is the one OpenAI-shaped verb a comfy
engine answers, for the caller that wants a prompt turned into an image and
should not have to learn a workflow format to get one.

```sh
curl -s localhost:29200/openai/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{"model":"@/comfy/local","prompt":"a red cube on a white table","size":"512x512"}' \
  | jq -r '.data[0].b64_json' | base64 -d > cube.png
```

| Field | Meaning |
| --- | --- |
| `prompt` | required, non-empty |
| `size` | `<width>x<height>`, default `1024x1024` |
| `n` | 1–10, default 1. One render each, with consecutive seeds — the door submits one prompt at a time, so `n` images take `n` renders' worth of wall clock |
| `negative_prompt` | not an OpenAI field, forwarded because a caller driving a diffusion model has no other way to say it |
| `seed` | honoured when given; random otherwise, so asking twice is not the same image |

The reply is always `b64_json`: there is no URL to hand out, because a URL
would be an address into the container's shared output directory and this door
does not hand those out.

**It does not replace the mediated proxy below, and is not meant to.** A node
graph, a custom sampler, an upscale chain, a video job — none of those is
expressible as an OpenAI image request. A consumer that needs them speaks comfy
through `/engined/v1/comfy/...` exactly as before; this verb is the simple case
given one shape.

The graph it renders ships with the engine (`images_workflow` in
`engines/comfy/spec.toml`), because a mis-wired node fails silently — a black
image, or a shape error from inside comfy naming a node rather than the graph.
Which checkpoints it loads is install-specific and comes from the comfy route's
`[route.args]` (`unet`, `clip`, `clip_type`, `vae`); a missing one is a 400
naming it, never a bad render.

**An image request cannot name a chain.** A second engine's render is a
different image, not a retry of the first, so there is nothing a fallback could
hand the caller that answers the request they made. That holds for both verbs.

### Editing an image

`POST /openai/v1/images/edits` is the same render started from the caller's own
image rather than an empty latent. Multipart, not JSON, because the image *is*
the request — base64 inside a JSON body would be a third bigger on the wire and
held twice in memory to decode.

```sh
curl -s localhost:29200/openai/v1/images/edits \
  --form-string model=@/comfy/local -F image=@cube.png \
  --form-string 'prompt=a deep blue cube on a white table' \
  | jq -r '.data[0].b64_json' | base64 -d > blue-cube.png
```

**`--form-string`, not `-F`, for every field but the image.** An address
begins `@/`, and `-F` reads a leading `@` as "upload this file" -- so
`-F model=@/comfy/local` sends curl looking for a file called `/comfy/local`
and it exits 26 without sending anything. Only `image=@cube.png` wants that
behaviour. The same applies to the translations verb above.

`prompt`, `n`, `negative_prompt` and `seed` mean what they do above.

| Field | Meaning |
| --- | --- |
| `image` | required: the image to start from, at most 32 MiB |
| `denoise` | how much of the input the sampler discards, greater than 0 and at most 1; default 0.9. At 1.0 nothing of the input survives, which is `/images/generations` |

**No `size`.** The input's own dimensions are the output's — scaling here would
silently resize what a caller handed over, and a caller who wants another size
can send another image.

Measured on Chroma1-HD, a red cube asked to become blue: at 0.6 and 0.75 the
cube stayed red -- the input dominates and the prompt has no visible effect --
and at 0.9 it turned blue with the composition still recognisably the input's.
Hence that default. The ladder is this checkpoint's, so re-check it against
your own rather than assuming a low denoise still honours a prompt.

The door uploads the image into the container's own input directory before
submitting, because a container reads only what was handed to it: a path from
the caller would name nothing. The graph is `images_edit_workflow` in the same
spec, a separate file from the generation graph for the same reason the
generation graph ships at all — the wiring is the half that fails silently.

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
`running` cancel truncates work already done. Neither reply can be wrong about
what the container did:

- A `pending` cancel is confirmed by a second queue read after the delete,
  because comfy answers 200 to a delete that removed nothing. A prompt that
  started rendering in that window is interrupted and reported `running`.
- A `running` cancel sends comfy's unscoped `/interrupt`, which is safe here
  only because **this door keeps one prompt in a comfy container at a time**.
  `POST /prompt` waits for the container's queue to drain before it forwards,
  so nothing is ever queued behind the running job to inherit the GPU from it.
  An interrupt that arrives after the prompt finished stops nothing at all.

That gate is the one behaviour change a comfy consumer sees. With the container
free — the ordinary case on a one-GPU box — a submission forwards immediately
and answers with comfy's own `prompt_id`, exactly as before. With a render in
flight, `POST /prompt` holds until it ends rather than returning an id for a
job queued behind it, so the wait moves from comfy's queue to the request. The
GPU was serial either way; what changes is where the caller waits, and that the
door can now say what is running. A container that has not drained inside the
engine's `drain_timeout_seconds` (15 minutes by default) answers 503 naming
the engine and that key, rather than holding the request forever.

The binding table those verbs read is bounded twice, by **age** and by
**count**. A binding is served for **seven days** from the moment its prompt was
submitted — not from the last time anyone polled it, so a consumer cannot hold
one open by polling — and the door keeps at most the 1000 most recent across
every comfy engine and caller, in memory and on disk, evicting oldest-first
past that. Both survive a door restart.

The age is the bound a consumer can plan around: fetch an output within a week
of producing it. The count is a bound on the table rather than on any one
binding, so on a busy box it can drop something younger than that. Past either,
`GET /view` refuses an output this door itself produced and `/cancel` and
`POST /queue` 404 an id they once knew, so an old filename is not a durable
URL.

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

### What a call cost

`usage` on an attempt is what that engine reported, copied rather than
derived: `prompt_tokens`, `completion_tokens`, `total_tokens`, and `cost_usd`,
each present only if the engine sent it.

`cost_usd` appears where the thing that ran worked the price out itself, which
in practice means the agentic CLIs. It is never engined multiplying tokens by
a rate card: no rate card lives in this repo, and one that did would be wrong
the week a provider repriced. It is also why an agentic attempt can carry a
cost and no `prompt_tokens` — claude splits its input side across three cache
tiers that bill at different rates (measured 2 / 21863 / 9869 on a four-token
reply), so their sum is not a prompt size worth charging against, while
`total_cost_usd` is exactly the figure the question wants. Summing these lines is how you find what a month
on a paid upstream came to, and which consumer spent it — nothing else on the
box records it.

Read the absences, because a sum that treats them as zero is wrong:

- **`"streamed": true` and no `usage`** — the upstream stated no cost in its
  frames. For an OpenAI-shaped one that means the caller did not send
  `stream_options: {"include_usage": true}`, which is the only thing that puts
  a usage frame in a streamed reply. Cost unknown, not zero — and the fix is
  the consumer's one-line change, not engined's: the door forwards a chat body
  untouched and will not add fields to a caller's request.
- **no `usage` and a `version`** — an agentic hop whose CLI stated nothing.
  The three shipped CLIs do state their own accounting, each in its own
  spelling, and all three are read: claude's `usage.output_tokens` plus
  `total_cost_usd`, opencode's `part.tokens` plus `part.cost` off its
  `step_finish` event, cursor's camelCase `usage.outputTokens`. Each was
  captured from a real run rather than guessed.
- **no `usage`, no `version`, not streamed** — the engine genuinely reported
  nothing. Every whisper transcription is this: whisper-server reports no
  usage, and the audio verbs are not token-billed anyway.

A streamed reply's `usage` is read out of the frames themselves, at the end,
where an upstream states the total — the provenance line for one is already
deferred until the stream ends, so the figure is there by the time the line is
written. The last usage frame wins, so an upstream restating a running total
ends on the total. A stream that dies after stating its cost still records it:
what was spent before it died was spent.

A field the engine sent as a non-number is dropped rather than coerced, so
every number on these lines came from the engine as a number. That is also why
a local llama stream can show no `usage` while plainly having done work:
measured on b10637, it reports token counts in a `timings` object instead, and
with a prefix-cache hit `timings.prompt_n` is only the uncached remainder
(`prompt_n: 4` against `usage.prompt_tokens: 12`). Deriving a figure from it
would be engined's arithmetic rather than the engine's answer, and llama is
the local engine no budget is counting.

engined enforces no ceiling and keeps no running total. The line is the
record; `journalctl --user -u engined` is the query.
