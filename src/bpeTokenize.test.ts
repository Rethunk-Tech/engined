import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bpeTokenIds } from './bpeTokenize.ts'
import type { BpeVocab } from './bpeVocab.ts'
import { loadBpeVocab, UnsupportedVocabError } from './bpeVocab.ts'
import './testtmp.ts'

/** A vocab small enough to hand-check every merge and lookup against, built directly rather than through a GGUF file -- `ggufMetadata.test.ts`/`tokenizeRoute.test.ts` cover the on-disk path. */
function vocab(pre: string, tokens: string[], merges: string[]): BpeVocab {
  return {
    pre,
    tokenToId: new Map(tokens.map((t, i) => [t, i])),
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

  test('a 40_000-space word against a real GGUF vocab finishes in under 200 ms', async () => {
    const realVocab = await loadOperatorBpeVocab()
    const word = `hello${' '.repeat(40_000)}x`
    const started = performance.now()
    const ids = bpeTokenIds(realVocab, word)
    expect(performance.now() - started).toBeLessThan(200)
    expect(ids.length).toBeGreaterThan(0)
  })
})

function tomlQuoted(text: string, key: string): string {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'))
  const value = match?.[1]
  if (value === undefined) {
    throw new Error(`~/.config/engined/config.toml has no ${key}`)
  }
  return value
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

async function loadOperatorBpeVocab(): Promise<BpeVocab> {
  const text = await Bun.file(join(homedir(), '.config/engined/config.toml')).text()
  const dir = expandHome(tomlQuoted(text, 'models_dir'))
  const names = [...text.matchAll(/^\s*filename\s*=\s*"([^"]+\.gguf)"/gm)].flatMap((m) => {
    const name = m[1]
    return name === undefined ? [] : [name]
  })
  const paths = names.map((name) => expandHome(join(dir, name))).filter((p) => existsSync(p))
  return await Promise.any(paths.map((p) => loadBpeVocab(p)))
}
