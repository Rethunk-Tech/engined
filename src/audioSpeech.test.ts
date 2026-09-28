import { describe, expect, test } from 'bun:test'
import { resetSpeechCache, speechCacheByteCount, storeSpeech } from './audioSpeech.ts'

describe('storeSpeech', () => {
  test('storing the same key twice replaces the byte count rather than adding to it', () => {
    resetSpeechCache()
    const bytes = Buffer.alloc(1024, 1)
    storeSpeech('key', bytes)
    storeSpeech('key', bytes)
    expect(speechCacheByteCount()).toBe(bytes.byteLength)
  })
})
