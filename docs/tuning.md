# Tuning (llama)

Measurements taken on this box against Ornith-1.5-35B-A3B MTPv2,
Vulkan/RADV, `q8_0` K/V. They justify the values `engines/llama/spec.toml`
and `config.example.toml` ship, and they are the reason those values are not
worth guessing at.

## Speculative decoding

`engines/llama/spec.toml` passes `--spec-type draft-mtp` for any catalog
model marked `mtp` — the head lives inside the GGUF, and llama.cpp only infers
a speculative type from a *separate* draft model, so it has to be named.
Naming it on a headless GGUF is fatal (`model doesn't contain MTP layers`,
exit 1), which is why the flags follow the model rather than being
unconditional.

### `spec-draft-p-min`

At `--ctx-size 32768`, 1200 tokens generated. "Prose" is an 8416-token
prompt; "structured" is a JSON array over the same context.

| config | prose tok/s | structured tok/s |
| --- | --- | --- |
| no speculation | 54.05 | 53.13 |
| `draft-mtp`, `p-min 0.95` | 47.75 | 60.91 |
| `draft-mtp`, `p-min 0.75` | 50.99 | 66.12 |
| `draft-mtp`, `p-min 0.10` | **54.70** | **66.99** |

The payoff tracks draft acceptance, which is a property of the output shape:
83% on prose against 98% on structured output. A high `p-min` is
counterproductive because the draft is computed before the gate reads it — the
threshold only decides whether work already done gets used. Hence `0.1`, where
prose is break-even and structured output gains ~26%.

Prompt processing is unaffected either way (~1000 tok/s on the 8.4k prompt):
speculation is a decode-side mechanism.

### `spec-draft-n-max`

At `p-min 0.1`, warm, same prompt: n=1 gives 62.94 t/s decode at 73% draft
acceptance, n=3 is 62.75 at 54%, n=12 collapses to 24.85 at 19% and n=16 to
22.30. Decode degrades monotonically as acceptance falls, so raising `n-max`
past 1 is a loss here. The config ships `spec-draft-n-max = 1`.

## Two traps when quoting these numbers

**Burst figures are not sustained figures.** The `n-max` numbers above are
32-token bursts. Acceptance decays with generation length and decode tracks
it almost exactly: the same build measures 62.6 t/s over 32 generated tokens
(93% acceptance), 54.3 over 128 (73%), and 54.0 over 512 (71%). Quote ~54 t/s
for anything that generates a paragraph, and never compare a decode number
taken over 32 tokens with one taken over 512.

**Do not reason from file size.** Decode on a sparse MoE tracks the *active*
bytes per token, not the size of the GGUF. Switching from a 36.9 GB Q8_0 file
to a 24.85 GB one is a 33% smaller file but only ~11% faster (49.60 → 55.40
tok/s, 400 tokens, short prompt), because only 8 of 256 experts are read per
token and this tier's active bpw barely moves.

## Parallel slots

`parallel = -1` is llama.cpp's auto (4 unified slots here): 62.94 t/s decode,
against 68.28 t/s at `-np 1 -kvu`. `-np 2` and above halves ctx-size per slot
by turning off kv_unified, which is not worth that footgun.

The door's admission cap follows that auto: a role whose merged `parallel` is
`-1`, `0`, or unset is admitted four at a time rather than uncapped, so the
queue forms at the door where it is visible instead of inside llama-server's
scheduler. That four is proven against the child's own `/props?model=<id>`
`total_slots`, asserted by `test/local/llama.test.ts` against the embed
route (whose merged `parallel` is left at the engine's `-1` auto rather than
overridden). A LLAMA_COMMIT bump re-measures the geometry table above AND
re-runs that assertion — a moved auto would otherwise desynchronise the two
silently, admitting more or fewer than the child agreed to.

## Cache-aware slot placement

Measured on ornith (live config `parallel = 4`) against real VS Code Copilot
chats, a new chat's ~31k-token prompt — identical in its first ~30k tokens to
the previous chat's — was fully re-prefilled (47-50s):

1. Copilot's small side requests (10-276 tokens) landed, by llama's own
   cross-request LRU, on the slot holding the long cached prompt.
2. Each side request overwrote that slot.
3. The long request then also landed by LRU and reprocessed all 30,951
   tokens.

llama-server's host-RAM prompt cache (`--cache-idle-slots`) does not restore
on this hybrid model, so placement is the fix, not a bigger buffer.

Placement applies to any local llama route whose merged `parallel` is a
positive integer `>= 2` (`src/llamaSlots.ts`, driven from `LlamaRouter.proxy`
in `src/llama.ts`):

| Rule | Behaviour |
| --- | --- |
| Slot classes | The first `ceil(parallel / 2)` slot ids are LONG, the rest SHORT. |
| Sizing | The prompt is counted with the vocab-only tokenizer (`src/bpeTokenize.ts`/`bpeVocab.ts`) against the GGUF `src/tokenizeRoute.ts` reads; `>= slot_long_threshold` (route config, default 4096) is LONG. |
| LONG request | The idle long slot whose prefix fingerprint (a hash of its first 2048 token ids) matches, else the least-recently-used idle long slot. |
| SHORT request | Only a short slot, least-recently-used idle first. |
| Nothing idle | No `id_slot` is sent; llama-server picks a slot itself. |
| Caller `id_slot` | Forwarded untouched. |

`GET /slots` on this build reports only `id`/`is_processing`/`n_ctx`/
`speculative` — nothing about what a slot has cached — so this table is
engined's own bookkeeping of what it last placed, not a read of the child's
real occupancy. It is memory-resident per `(engine, model)` and does not
survive a config reload that recreates the container.

## Reusing a cached prompt on a hybrid model

Ornith is a hybrid (recurrent + attention) model: llama-server can resume a
cached prompt only at a message boundary, not at an arbitrary token. A request
whose prompt differs anywhere inside a message is recomputed from that
message's start. Measured on ornith with a 31k-token prompt changed at 85%:

| Same text sent as | Tokens reused | Prefill |
| --- | --- | --- |
| 1 message | 0 | 52.5 s |
| 16 messages | 21,849 | 17.8 s |
| 64 messages | 26,014 | 11.4 s |

VS Code Copilot sends its agent instructions as one ~15k-token user message
that changes somewhere per chat, so new chats reused only the ~16k-token tool
block and took ~30 s. [engined-vscode](https://github.com/Rethunk-Tech/engined-vscode)
splits long user messages at structural boundaries (its prompt splitter); new
chats then reprocess about 520 tokens, 2-6 s end to end. A consumer that sends long,
partly-changing messages to a hybrid route gets the same benefit from
splitting them.

Measured and not worth it for this: `--checkpoint-min-step 1024` (default
8192) reused exactly as much as the default, and `--cache-idle-slots` with the
default `--cache-ram` never restored anything on this model. Neither is set.

## Measurements behind the spec comments (build b10637, Strix Halo, 2026-10)

Slot geometry by `parallel`:

| `parallel` | `n_slots` | `n_ctx_slot` | `kv_unified` |
| ------ | ------ | ------ | ------ |
| -1 | 4 | 32768 | true |
| 1 | 1 | ctx-size | false |
| 2 | 2 | ctx-size / 2 | false |

`-1` is one shared 32768 pool, not four windows: 24.62 GiB loaded against a
23.13 GiB GGUF, where 32768 tokens of q8_0 KV is 0.64 GiB and four independent
windows would be 2.56 GiB on their own. At `parallel = 2`, `ctx-size = 262144`
is two independent 131072 windows; 262144 tokens of q8_0 KV is ~5.1 GiB (27.20
GiB loaded), and GTT held 48.6 GB of 133 GB with ornith resident.

Concurrency at `parallel = 1`: three simultaneous ornith requests waited
0.18 / 2.41 / 4.73 s. Concurrent generation at `parallel = 2` is slower per
request than solo (3.27 s against 2.06 s for 128 tokens) because slots share
memory bandwidth.

Prefix cache (default `cache_prompt`): an identical ~2226-token system prompt
prefills in 1903.9 ms cold (2.20 s total) and 64.3 ms warm with `cache_n=2222`
(0.32 s total), an 85% cut. Prefill runs 1169-1291 t/s on real prompts. Swap
between the two GGUFs on disk is 8-16 s warm, scaling with file size.

Backend and fork: the PrismML fork decodes ornith at 64-69 t/s against 59.8 on
a mainline-based build. A ROCm backend decodes at 54.1 t/s against Vulkan's
69.1 on ornith, with better prefill (113 t/s against 46) that does not pay for
it. Draft acceptance observed live is 72-92%.
