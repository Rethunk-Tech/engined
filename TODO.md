# TODO

Work that is decided but not built. `AGENTS.md` and `docs/` describe what
exists; this file is the only place that describes what does not.

Sections are unordered.

## History with no snapshots renders an empty table

`UsageView` (`src/configsvc/ui/usage.tsx:41`) shows "No calls recorded." when
the filtered list is empty. `HistoryView` (`src/configsvc/ui/history.tsx:33`)
always renders `<table class="grid">` even when `entries` is `[]`, so a
fresh install's History page is a blank grid under the "newest 20" sentence.

The same empty-state pattern: when `entries.length === 0`, a muted line
("No previous saves.") instead of the table. The intro sentence stays.

Rejected: hiding the view from the nav until the first save. History is
where restore lives; it must be findable.

### Read

1. `src/configsvc/ui/history.tsx:13` `HistoryView` and `:33` the table.
2. `src/configsvc/ui/usage.tsx:41` — the copy to match.
3. `src/configsvcApi.ts:223` `GET /api/history` — already returns
   `{ entries: [] }` for a new dir.

### Traps

- **`shown` can outlive an empty list** if a restore then a re-fetch
  clears entries while a diff is open. Clear `shown` when entries become
  empty, or leave the diff; either is fine as long as the table does not
  reappear empty under it.

### Acceptance

- A config dir with no `.history` files renders the muted empty line and
  no table rows.
- After one save, the table lists that snapshot.
- `gate` stays green.

## Route Test skip text always names image routes

`cheapCheck` (`src/configsvcLive.ts`) now probes chat, completions,
embeddings, rerank, speech, transcriptions, and translations. When none of
those are in `serves`, `testRoute` at `:371` still answers
`skipped: 'image routes have no cheap test: one would load the diffusion
model'`. That sentence is true for `/openai/v1/images/generations` and
edits. It is a lie for any other remaining verb (agentic-only paths that
do not list chat, a future role).

Branch the skip: if `serves` includes an images path, keep today's sentence;
otherwise say the route has no cheap test and name the paths it does serve.

Rejected: adding a cheap image ping. Loading a checkpoint is the reason the
skip exists (`AGENTS.md` comfy memory).

### Read

1. `src/configsvcLive.ts:370` the skip payload.
2. `src/routeServes.ts` `CONTENT_ENDPOINT_IMAGES` /
   `CONTENT_ENDPOINT_IMAGE_EDITS` — the image paths.
3. `src/configsvc.test.ts` "route Test calls the verb the route serves" —
   TTS must still not skip.

### Traps

- **The UI prints `skipped` verbatim** (`src/configsvc/ui/routes.tsx`
   `TestBadge`). Changing the image sentence is visible to operators who
   already know the old words; keep that string for image `serves`.
- **`serves` can be empty.** Name "nothing" rather than joining an empty
  list into a dangling colon.

### Acceptance

- A route whose `serves` includes `/openai/v1/images/generations` still
  skips with the current image sentence.
- A route whose `serves` is only a non-cheap, non-image path skips with a
  sentence that does not say "image".
- `gate` stays green.

## Tokenize has no detokenize

`POST /engined/v1/tokenize` (`src/tokenizeRoute.ts:28`) turns `content` into
token ids for a GGUF whose vocab the door can read. llama-server also
serves `/detokenize`. The door does not. A client that tokenized through
engined cannot ask it for the inverse without speaking to the container.

A sibling `POST /engined/v1/detokenize` that accepts the ids tokenize
emitted and returns text, same model addressing, same 4 MiChar-class
limit in the other direction (id count, not characters). Only the vocabs
`supportsVocabTokenize` already accepts.

Rejected: proxying llama-server's `/detokenize` while the model is
resident. Tokenize is deliberately off the GPU path (`bpeTokenize.ts`);
detokenize must stay on that same CPU vocab so a stopped engine still
answers.

This is a new door verb. It changes the public surface and needs
http-api.md in the same change.

### Read

1. `src/tokenizeRoute.ts:28` `TOKENIZE_PATH` and `handleTokenizeRoute`.
2. `src/bpeTokenize.ts` — the encode to invert.
3. `src/modelsMenu.ts:159` — tokenize is advertised on `serves`; detokenize
   would join it the same way.
4. `src/main.ts:189` POST routing and `allowFor`.
5. `docs/http-api.md` tokenize section — the page a new verb must join.

### Traps

- **Ids are not a round-trip for every pretokenizer.** Document that the
  text is the join of the pieces those ids name, which may not equal the
  original `content` (leading spaces, special tokens).
- **A client sending llama-server's `/tokenize` shape** (`content` vs
  `prompt`) already has a door-specific body. Detokenize should take the
  array tokenize returned, not invent a second id field name.
- **No port, no GPU.** Detokenize must not start an engine.

### Acceptance

- `POST /engined/v1/detokenize` with the ids of a prior tokenize on the
  same model returns 200 and text.
- A model tokenize refuses still refuses detokenize.
- `GET /openai/v1/models` lists the path on the same rows tokenize does.
- `docs/http-api.md` names the verb.
- `gate` stays green.
