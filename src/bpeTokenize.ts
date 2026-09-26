/**
 * GPT-2-style byte-level BPE, run against a `BpeVocab`'s tables. This is the
 * same split-then-merge algorithm every byte-level BPE tokenizer runs
 * (llama.cpp's own `llm_tokenizer_bpe_session::tokenize` included); the
 * pretokenizer regex per `tokenizer.ggml.pre` value is copied verbatim from
 * llama.cpp's `src/unicode.cpp` (the "original regex from tokenizer.json"
 * comment above each `unicode_regex_split_custom_*` function there), which
 * llama.cpp's own custom splitters exist only to run faster than a general
 * regex engine -- the pattern itself is the ground truth both are computing.
 */

import type { BpeVocab } from './bpeVocab.ts'
import { UnsupportedVocabError } from './bpeVocab.ts'

/**
 * Pretokenizer regexes by `tokenizer.ggml.pre`. Every entry here is one
 * self-contained alternation (llama.cpp calls `unicode_regex_split` with a
 * list of exactly one regex_expr for each of these), so a single global
 * match pass reproduces the split. Regex literals, not pattern strings, so
 * each is compiled once at module load rather than re-parsed per call.
 */
const PRETOKENIZER_PATTERNS: Readonly<Record<string, RegExp>> = {
  // QWEN2 / STABLELM2 / HUNYUAN / SOLAR_OPEN share this pattern in llama.cpp.
  qwen2:
    /(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu,
  qwen35:
    /(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+|\p{N}| ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu,
  // GPT2 / MPT / OLMO / JAIS / TRILLION / GRANITE_DOCLING.
  gpt2: /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)/gu,
}

/** `String.prototype.matchAll` clones its regex argument (fresh `lastIndex`) before iterating, so the module-level instance is safe to hand out to concurrent calls unmodified. */
function pretokenizerRegex(pre: string): RegExp {
  const re = PRETOKENIZER_PATTERNS[pre]
  if (re === undefined) {
    throw new UnsupportedVocabError(
      `tokenizer.ggml.pre "${pre}" has no pretokenizer implemented here`,
    )
  }
  return re
}

function splitWords(content: string, pre: string): string[] {
  return [...content.matchAll(pretokenizerRegex(pre))].map((m) => m[0])
}

/** The standard GPT-2 byte encoder: every byte 0-255 maps to one printable, single-codepoint character, so a merges list built from vocab strings never has to represent a raw control byte. */
const BYTE_TO_CHAR: readonly string[] = (() => {
  const table = new Array<string>(256)
  const printable = new Set<number>()
  for (let b = 0x21; b <= 0x7e; b++) {
    printable.add(b)
  }
  for (let b = 0xa1; b <= 0xac; b++) {
    printable.add(b)
  }
  for (let b = 0xae; b <= 0xff; b++) {
    printable.add(b)
  }
  let next = 256
  for (let b = 0; b < 256; b++) {
    table[b] = String.fromCodePoint(printable.has(b) ? b : next)
    if (!printable.has(b)) {
      next += 1
    }
  }
  return table
})()

/** Every byte of `word`'s UTF-8 encoding, escaped through `BYTE_TO_CHAR` -- the alphabet `tokenizer.ggml.tokens` and `.merges` are both written in. */
function byteEncode(word: string): string {
  const bytes = new TextEncoder().encode(word)
  let out = ''
  for (const b of bytes) {
    out += BYTE_TO_CHAR[b]
  }
  return out
}

/** One BPE-mergeable symbol chain, as an array of substrings of `word`; merging joins two adjacent entries into one. */
function bpeMerge(word: string, mergeRank: ReadonlyMap<string, number>): string[] {
  let symbols = Array.from(word)
  if (symbols.length <= 1) {
    return symbols
  }
  for (;;) {
    let bestRank = Number.POSITIVE_INFINITY
    let bestIndex = -1
    for (let i = 0; i < symbols.length - 1; i++) {
      const rank = mergeRank.get(`${symbols[i]} ${symbols[i + 1]}`)
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank
        bestIndex = i
      }
    }
    if (bestIndex === -1) {
      return symbols
    }
    const left = symbols[bestIndex]
    const right = symbols[bestIndex + 1]
    if (left === undefined || right === undefined) {
      throw new Error('bpeMerge: rank matched a pair outside the symbol array')
    }
    symbols = [...symbols.slice(0, bestIndex), left + right, ...symbols.slice(bestIndex + 2)]
  }
}

/**
 * `symbol` first, then (mirroring llama.cpp's own fallback) each of its
 * escaped bytes individually -- every one of those 256 characters is a base
 * vocab entry in a real byte-level BPE vocab, so this only actually falls
 * through on a vocab this door's caller mis-declared.
 */
function tokenIdsFor(vocab: BpeVocab, symbol: string): number[] {
  const whole = vocab.tokenToId.get(symbol)
  if (whole !== undefined) {
    return [whole]
  }
  return Array.from(symbol).map((byteChar) => {
    const id = vocab.tokenToId.get(byteChar)
    if (id === undefined) {
      throw new UnsupportedVocabError(`token "${byteChar}" has no id in this vocab`)
    }
    return id
  })
}

/** Tokenizes `content` against `vocab`, returning the ids llama-server's own `/tokenize` would report for the same GGUF -- the split, byte-encode and merge steps are the ones its BPE session runs, read straight off llama.cpp's own source. */
export function bpeTokenIds(vocab: BpeVocab, content: string): number[] {
  const ids: number[] = []
  for (const word of splitWords(content, vocab.pre)) {
    const encoded = byteEncode(word)
    for (const symbol of bpeMerge(encoded, vocab.mergeRank)) {
      ids.push(...tokenIdsFor(vocab, symbol))
    }
  }
  return ids
}
