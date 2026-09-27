/**
 * Turns one GGUF's `tokenizer.ggml.*` metadata into the two lookup tables
 * `bpeTokenize.ts` runs against: token id by escaped-byte string, and merge
 * priority by the pair it joins. Built once per file path and cached, since
 * a 250k-token vocab is the whole cost this module exists to pay instead of
 * loading the weights that follow it on disk.
 */

import { readGgufMetadata } from './ggufMetadata.ts'

/** A GGUF whose tokenizer this door cannot count against without guessing -- reported to the caller, never silently approximated. */
export class UnsupportedVocabError extends Error {}

export interface BpeVocab {
  /** `tokenizer.ggml.pre`, kept for the pretokenizer registry lookup in `bpeTokenize.ts`. */
  pre: string
  tokenToId: ReadonlyMap<string, number>
  /** Rank by `"<left> <right>"`; lower merges first. Ties never occur -- each pair appears at most once in `tokenizer.ggml.merges`. */
  mergeRank: ReadonlyMap<string, number>
}

/** Only the vocab shape this file's tables cover: GPT-2 byte-level BPE, the merges array present. Every other `tokenizer.ggml.model` (SentencePiece "llama", "bert", ...) needs a different algorithm entirely. */
const SUPPORTED_TOKENIZER_MODEL = 'gpt2'

async function buildBpeVocab(path: string): Promise<BpeVocab> {
  const meta = await readGgufMetadata(path)
  if (meta.tokenizerModel !== SUPPORTED_TOKENIZER_MODEL) {
    throw new UnsupportedVocabError(
      `${path}: tokenizer.ggml.model is "${meta.tokenizerModel ?? 'unknown'}", not "${SUPPORTED_TOKENIZER_MODEL}" -- this vocab needs a different tokenizer than the one this door has`,
    )
  }
  if (meta.tokens === undefined || meta.merges === undefined) {
    throw new UnsupportedVocabError(`${path}: no tokenizer.ggml.tokens/merges in this GGUF`)
  }
  if (meta.tokenizerPre === undefined) {
    throw new UnsupportedVocabError(
      `${path}: no tokenizer.ggml.pre naming which pretokenizer to run`,
    )
  }
  const tokenToId = new Map(meta.tokens.map((tok, id) => [tok, id] as const))
  const mergeRank = new Map(meta.merges.map((pair, rank) => [pair, rank] as const))
  return { pre: meta.tokenizerPre, tokenToId, mergeRank }
}

const vocabCache = new Map<string, Promise<BpeVocab>>()

/** Loads and caches the BPE vocab for `path` (an absolute GGUF path). Repeat calls for the same file reuse the same tables. */
export function loadBpeVocab(path: string): Promise<BpeVocab> {
  let cached = vocabCache.get(path)
  if (cached === undefined) {
    cached = buildBpeVocab(path)
    vocabCache.set(path, cached)
    // UnsupportedVocabError is a property of the file: retrying will not
    // change the tokenizer. Transient read errors are evicted so a later
    // call can try again.
    cached.catch((err: unknown) => {
      if (!(err instanceof UnsupportedVocabError)) {
        vocabCache.delete(path)
      }
    })
  }
  return cached
}
