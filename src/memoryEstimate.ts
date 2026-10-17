/** Resident-memory estimate for a llama route from its GGUF header and cache settings; no tensors are read. */

/** The GGUF facts the estimate needs, as `/api/models` reports them. */
export interface GgufShape {
  context_length?: number
  block_count?: number
  head_count?: number
  head_count_kv?: number
  embedding_length?: number
  key_length?: number
  value_length?: number
}

/** llama.cpp cache types by bytes per element (block bytes / block elements). */
const CACHE_TYPE_BYTES: Record<string, number> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32,
  q4_0: 18 / 32,
  q4_1: 20 / 32,
  q5_0: 22 / 32,
  q5_1: 24 / 32,
  iq4_nl: 18 / 32,
}
const DEFAULT_CACHE_BYTES = 2

const cacheBytesPerElement = (type: unknown): number =>
  (typeof type === 'string' ? CACHE_TYPE_BYTES[type.toLowerCase()] : undefined) ??
  DEFAULT_CACHE_BYTES

/**
 * KV cache bytes: layers x ctx x kv heads x (K head dim x K bytes + V head dim x V bytes).
 * `ctx` is the whole pool; llama-server's parallel slots split it rather than multiply it.
 * Undefined when the header lacks a layer or head count.
 */
function kvCacheBytes(
  gguf: GgufShape,
  ctx: number,
  cacheTypeK?: unknown,
  cacheTypeV?: unknown,
): number | undefined {
  const { block_count: layers, head_count: heads, embedding_length: embedding } = gguf
  if (layers === undefined || heads === undefined || heads === 0) {
    return undefined
  }
  const kvHeads = gguf.head_count_kv ?? heads
  const keyDim = gguf.key_length ?? (embedding === undefined ? undefined : embedding / heads)
  if (keyDim === undefined) {
    return undefined
  }
  const valueDim = gguf.value_length ?? keyDim
  return (
    layers *
    ctx *
    kvHeads *
    (keyDim * cacheBytesPerElement(cacheTypeK) + valueDim * cacheBytesPerElement(cacheTypeV))
  )
}

/** Weights (file size) plus KV cache at `ctx`, falling back to the trained context; the file size alone when the header cannot size a cache. */
export function estimateResidentBytes(
  file: { bytes: number; gguf?: GgufShape },
  ctx: number | undefined,
  cacheTypeK?: unknown,
  cacheTypeV?: unknown,
): { bytes: number; ctx: number | undefined } {
  const effective = ctx ?? file.gguf?.context_length
  const kv =
    file.gguf === undefined || effective === undefined
      ? undefined
      : kvCacheBytes(file.gguf, effective, cacheTypeK, cacheTypeV)
  return { bytes: file.bytes + (kv ?? 0), ctx: effective }
}

export interface EngineMemory {
  resident: number
  largestOnDemand: number
}

/** keep_resident routes load together; on-demand ones swap, so only the largest counts. */
export function engineMemory(
  routes: readonly { resident: boolean; bytes: number }[],
): EngineMemory {
  let resident = 0
  let largestOnDemand = 0
  for (const r of routes) {
    if (r.resident) {
      resident += r.bytes
    } else {
      largestOnDemand = Math.max(largestOnDemand, r.bytes)
    }
  }
  return { resident, largestOnDemand }
}

export interface BoxMemory {
  total: number
  available: number
}

/** The warning (bad) or the softer note for a needed byte count against the box, if either applies. */
export function memoryVerdict(
  needed: number,
  box: BoxMemory,
): { level: 'bad' | 'note'; text: string } | undefined {
  if (needed > box.total) {
    return { level: 'bad', text: 'resident plus the largest on-demand model exceeds total memory' }
  }
  if (needed > box.available) {
    return {
      level: 'note',
      text: 'resident plus the largest on-demand model exceeds memory available now',
    }
  }
  return undefined
}
