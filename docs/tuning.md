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
