import { expect, test } from 'bun:test'
import { handleAudioTranscription } from './audioDoorTranscribe.ts'

test('multipart file Blob is not copied via arrayBuffer', async () => {
  const orig = Blob.prototype.arrayBuffer
  let calls = 0
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob) {
    calls += 1
    return orig.call(this)
  }
  try {
    const form = new FormData()
    form.append('file', new File([], 'clip.wav'))
    const req = new Request('http://127.0.0.1/openai/v1/audio/transcriptions', {
      method: 'POST',
      body: form,
    })
    const res = await handleAudioTranscription({} as never, req)
    expect(res.status).toBe(400)
    expect(calls).toBe(0)
  } finally {
    Blob.prototype.arrayBuffer = orig
  }
})
