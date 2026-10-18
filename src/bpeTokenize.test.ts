import { describe, expect, test } from 'bun:test'
import { bpeDetokenize, bpeTokenIds } from './bpeTokenize.ts'
import type { BpeVocab } from './bpeVocab.ts'
import { UnsupportedVocabError } from './bpeVocab.ts'
import './testtmp.ts'

/** A vocab small enough to hand-check every merge and lookup against, built directly rather than through a GGUF file -- `ggufMetadata.test.ts`/`tokenizeRoute.test.ts` cover the on-disk path. */
function vocab(pre: string, tokens: string[], merges: string[]): BpeVocab {
  return {
    pre,
    tokenToId: new Map(tokens.map((t, i) => [t, i])),
    idToToken: tokens,
    mergeRank: new Map(merges.map((m, i) => [m, i])),
  }
}

describe('bpeTokenIds', () => {
  test('two symbols with a rank for their pair merge into one token', () => {
    const v = vocab('qwen2', ['a', 'b', 'ab'], ['a b'])
    expect(bpeTokenIds(v, 'ab')).toEqual([2])
  })

  test('merges apply lowest-rank-first, not leftmost-first', () => {
    // "b c" ranks lower than "a b" would if position decided it; "a b" is
    // rank 0 here, so it must merge before "b c" even looks eligible.
    const v = vocab('qwen2', ['a', 'b', 'c', 'ab', 'bc'], ['a b', 'b c'])
    expect(bpeTokenIds(v, 'abc')).toEqual([3, 2]) // "ab", "c"
  })

  test('the qwen2 pretokenizer splits a contraction off the word it trails', () => {
    // Tokens: "'"=0 "s"=1 "'s"=2 "i"=3 "t"=4 "it"=5. "it's" splits as "it" +
    // "'s" under the qwen2 pattern (the letter-run alternative stops at the
    // apostrophe; the contraction alternative then matches "'s" on its own).
    const v = vocab('qwen2', ["'", 's', "'s", 'i', 't', 'it'], ['i t', "' s"])
    expect(bpeTokenIds(v, "it's")).toEqual([5, 2])
  })

  test('a pretokenizer type nobody registered here is refused, not silently guessed', () => {
    const v = vocab('some-future-pretokenizer', ['a'], [])
    expect(() => bpeTokenIds(v, 'a')).toThrow(UnsupportedVocabError)
  })

  test('a symbol absent from the vocab falls back to its individual escaped bytes', () => {
    // "ab" has no vocab entry of its own, but "a" and "b" do -- the fallback
    // llama.cpp's own tokenizer runs for exactly this shape.
    const v = vocab('qwen2', ['a', 'b'], ['a b'])
    expect(bpeTokenIds(v, 'ab')).toEqual([0, 1])
  })

  test('a token this door truly cannot represent is refused rather than dropped', () => {
    const v = vocab('qwen2', ['x'], [])
    expect(() => bpeTokenIds(v, 'a')).toThrow(UnsupportedVocabError)
  })

  test('a run of spaces four times longer costs well under sixteen times the rank lookups', () => {
    // Each rank doubles a run of spaces, so a naive merge rescans the whole
    // word once per merge: quadratic in the run length, 16x the lookups for a
    // 4x run. Counting lookups rather than timing them cannot flake on a busy box.
    const tokens = ['h', 'e', 'l', 'o', 'x', 'Ġ']
    const merges: string[] = []
    let run = 'Ġ'
    for (let i = 0; i < 16; i++) {
      merges.push(`${run} ${run}`)
      run += run
      tokens.push(run)
    }
    class CountingMap extends Map<string, number> {
      lookups = 0
      override get(key: string): number | undefined {
        this.lookups += 1
        return super.get(key)
      }
    }
    const lookups = (spaces: number): number => {
      const mergeRank = new CountingMap(merges.map((m, i) => [m, i]))
      const v = { ...vocab('qwen2', tokens, []), mergeRank }
      expect(bpeTokenIds(v, `hello${' '.repeat(spaces)}x`).length).toBeGreaterThan(0)
      return mergeRank.lookups
    }
    expect(lookups(40_000) / lookups(10_000)).toBeLessThan(8)
  })
})

describe('bpeDetokenize', () => {
  test('the join of the pieces those ids name, byte-decoded, not a guaranteed round-trip of content', () => {
    const v = vocab('gpt2', ['h', 'i', 'Ġ'], [])
    expect(bpeDetokenize(v, [2, 0, 1])).toBe(' hi')
  })

  test('an id nobody in this vocab owns is refused rather than skipped', () => {
    const v = vocab('qwen2', ['a'], [])
    expect(() => bpeDetokenize(v, [1])).toThrow(UnsupportedVocabError)
  })
})
