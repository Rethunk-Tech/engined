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
