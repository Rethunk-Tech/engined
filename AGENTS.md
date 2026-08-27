# engined

Design only. Nothing here is built. `TODO.md` is the authoritative artifact —
the broker's behaviour, the constraints every phase inherits, the config shape
and the phases in build order. `docs/migrations/` holds one cutover guide per
consumer. `README.md` says only what the service is.

## Before committing

`python3 scripts/doc-sweep.py TODO.md README.md docs/migrations/*.md`, or
`gate run docs`. It catches edit damage a reader misses: a sentence that lost its
tail to a partial revision, an unclosed fence, a term declared absent in one
section and still required by an acceptance criterion in another.

## Editing the migration guides

Each guide describes a real repository that is on disk. Anchors are
`path:symbol` with a line number as a hint — **grep the symbol**, line numbers
drift. A claim about a consumer's behaviour is checkable against that consumer's
source, so check it rather than reasoning from the guide.

## Two rules that keep being rediscovered

**No port is written down for anything engined starts.** The container side comes
from the image's `EXPOSE`, the host side from Docker. The door is the sole
exception, plus a remote upstream's `base_url`.

**The agentic guarantee is integrity, not confidentiality.** An agentic call
cannot change a caller's worktree. It can read anything this uid can open. Any
wording implying `workdir` bounds reads is wrong.
