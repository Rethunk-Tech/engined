# TODO

Work that is decided but not built. `AGENTS.md` and `docs/` describe what
exists; this file is the only place that describes what does not.

Sections are unordered.

## Settings has Door and Config UI tables and no Potluck

`SettingsView` already renders every root scalar (`TOP` at
`src/configsvc/ui/settings.tsx:10`) and every `[configsvc]` key (`CONFIGSVC`
at `:18`) through `Prop`, the same control engines and routes use. `[potluck]`
is the remaining root table: `configSchema.ts:275` lists it next to
`configsvc`, parse already materialises `callback_url` and `callback_secret`
in `src/configUpstream.ts:38`, and the door posts liveness from
`src/potluck.ts`. An operator who needs the callback can only paste TOML on
Raw. The form is the gap, not the parser.

A third section titled Potluck, same shape as Config UI. `callback_url` is a
`Prop` on table `potluck`. `callback_secret.service` and
`callback_secret.username` are `Prop`s on table `callback_secret`, paths
`['potluck', 'callback_secret', 'service']` and `username`, matching
`SecretBox` on an upstream. A Store/Clear pair against the existing
`/api/secret` and `/api/secret/clear` verbs, keyed by those two fields, so a
callback bearer can be written without leaving the page.

Rejected: a dedicated Potluck view. The table is two strings and a secret
ref; it is not a catalog. Rejected: auto-creating `[potluck]` on first
keystroke of an empty install — an absent table means this box is not a
donor, and writing an empty table would fail parse (`callback_url` and
`callback_secret` are required at `config.schema.json` `$defs.potluck`).

The schema and the door's potluck post stay as they are.

### Read

1. `src/configsvc/ui/settings.tsx:20` `SettingsView` — Door then Config UI, no
   third section. Copy the Config UI block.
2. `src/configSchema.ts:275` `potluck` — the root key Settings omitted.
   `:291` `$defs.potluck` / `:296` `callback_secret` name the `Prop` tables.
3. `src/configsvc/ui/upstreams.tsx:80` `SecretBox` — Store/Clear against
   `/api/secret`. Reuse those two POSTs; do not add a third secret verb.
4. `src/configUpstream.ts:38` `parsePotluck` — required keys and the
   `SecretRef` shape a blank form must not emit.
5. `src/configsvc/ui/schema.ts:26` `propOf` — already resolves `$defs`
   `potluck` and `callback_secret`.

### Traps

- **An empty `[potluck]` does not parse.** Both `callback_url` and
  `callback_secret` are required. The section must leave the table absent
  until both names and the URL are set, or validate before `setKey` writes
  a partial table.
- **The callback secret is not an upstream secret.** `GET /api/secrets` lists
  only `config.upstreams` refs (`src/configsvcLive.ts` `secrets`). Presence
  for the potluck item is a `present(service, username)` call of its own,
  not a row in that list.
- **`Prop` table `secret` is the upstream shape** (`header`, `scheme`
  required). Potluck's ref is `callback_secret` (service + username only).
  Using table `secret` would offer keys potluck parse rejects.

### Acceptance

- Settings shows a Potluck section after Config UI.
- Filling `callback_url`, `service`, and `username` writes `[potluck]` that
  `loadConfig()` accepts.
- Store writes the keyring item those two attributes name; Clear drops it.
- An install with no `[potluck]` still saves from Settings without a parse
  error.
- `gate` stays green.

## CopyButton swallows a clipboard failure

`CopyButton` (`src/configsvc/ui/widgets.tsx:9`) sets `done` on a successful
`writeText` and shows "Copied". The `catch` at `:16` only clears `done`. A
non-secure context, or a browser that refused clipboard permission, leaves
the button labeled Copy with no reason. Loopback is a secure context, so this
is rare, but the failure path has no message.

One extra state, the same 1200 ms flash: on catch, show "Copy failed" (or
keep the existing label and set `title` to the error). Do not invent a toast.

Rejected: a fallback `textarea` + `execCommand('copy')`. The button already
documents that loopback is enough.

### Read

1. `src/configsvc/ui/widgets.tsx:9` `CopyButton` — the only clipboard writer
   in the UI.
2. Call sites (`chains.tsx`, `engines.tsx`, `upstreams.tsx`, `routes.tsx`,
   `addressbook.tsx`, `models.tsx`, `doctor.tsx`, `mapview.tsx`) — they pass
   `label`/`title` and must keep working when copy succeeds.

### Traps

- **`done` is overloaded.** A boolean cannot say Copied versus failed. A
  third value, or a separate `failed` flag, is required or success and
  failure flash the same word.
- **Secure-context is the common case.** A test that always fails copy is
  lying about loopback. Inject `writeText`, do not depend on the real
  clipboard.

### Acceptance

- A rejected `writeText` shows a failure label (or title) for ~1200 ms, then
  returns to `label ?? 'Copy'`.
- A successful copy still shows "Copied" and does not show the failure word.
- `gate` stays green.

## A known configsvc path asked with the wrong method is 404

The door names every method a path serves (`src/main.ts` `allowFor`,
`methodNotAllowed` in `src/http.ts:146`) and answers 405 with `Allow`. The
config UI does not: `configApi` (`src/configsvcApi.ts:209`) returns
undefined for a non-POST/GET, `liveApi` (`src/configsvcLive.ts`) only
handles GET then POST, and `handle` at `src/configsvc.ts:149` maps a miss
to 404 "not found". `POST /api/config` and `GET /api/save` therefore look
like unknown URLs.

Per path, the methods that already exist, then 405 with `Allow` listing
them, using `methodNotAllowed`. Unknown paths stay 404.

Rejected: treating every `/api/*` miss as 405. A typo must stay 404.

This is a status-code change. Callers that branch on 404 for a wrong-method
probe will see 405 instead.

### Read

1. `src/configsvc.ts:149` — the 404 fallback after `configApi` and `liveApi`.
2. `src/configsvcApi.ts:209` `configApi` and `src/configsvcLive.ts` `liveApi`
   — today's GET/POST split.
3. `src/http.ts:146` `methodNotAllowed` — the door's 405 + `Allow`.
4. `src/configsvc.test.ts:123` — asserts `/nothing` is 404; keep that. Add a
   wrong-method case on `/api/config` and `/api/save`.

### Traps

- **HEAD is GET-with-no-body on the door** (`headOf`). Configsvc does not
  advertise HEAD today. Adding it is a separate change; 405 for HEAD on
  `/api/config` is correct until HEAD is implemented.
- **`/login` and `/logout` are not `configApi`.** Their methods stay as
  they are; a GET `/login` is still whatever it is today.

### Acceptance

- `POST /api/config` (signed in) is 405 with `Allow` containing `GET`.
- `GET /api/save` is 405 with `Allow` containing `POST`.
- `GET /api/no-such-route` is still 404.
- `gate` stays green.

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

## Upstream disable is only a buried field

Engines (`src/configsvc/ui/engines.tsx` Enable/Disable in the row head),
routes, and chains expose disable as a header button. Upstreams
(`src/configsvc/ui/upstreams.tsx:187` `UpstreamCard`) put `disable` in the
State `Prop` section (`SECTIONS` at the top of that file) and have no
header button. An operator scanning cards can disable an engine in one
click and has to open State to disable an upstream.

A header Enable/Disable button identical to `EngineCard`'s, writing
`['upstream', index, 'disable']` as `true` or `undefined`. Keep the State
`Prop` so the three-state absent/true/false control remains available.

Rejected: removing the State `Prop`. Absent versus `false` is a real
distinction the button's two-state cannot show.

### Read

1. `src/configsvc/ui/engines.tsx` the Enable/Disable `editDraft` — copy it.
2. `src/configsvc/ui/upstreams.tsx:25` `SECTIONS` State `disable`.
3. `src/configsvc/ui/upstreams.tsx:187` `UpstreamCard` row head.

### Traps

- **Two controls on one key.** The button should match the Prop: `true`
  means Disable shown as Enable, anything else means Enable shown as
  Disable. Do not write `false` from the button; engines write `undefined`.
- **`off` CSS class already keys on `upstream.disable === true`.** Keep that.

### Acceptance

- An enabled upstream card has a Disable button in the row head; clicking
  it sets `disable = true` and the card gets `off`.
- Enable clears the key (does not write `false`).
- The State Prop still edits the same key.
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
