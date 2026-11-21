import { expect, test } from 'bun:test'
import { handleAudioTranscription } from './audioDoorTranscribe.ts'
import { transcribeRemote } from './audioTranscribe.ts'
import { startFakeUpstream } from './test-support.ts'

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

test('a remote transcription does not follow an upstream redirect with the key', async () => {
  const dest = startFakeUpstream(() => Response.json({ text: 'hi' }))
  const src = startFakeUpstream(
    () =>
      new Response(null, { status: 307, headers: { Location: `${dest.base}/v1/speech-to-text` } }),
  )
  try {
    await expect(
      transcribeRemote(
        { engine: 'eleven', file: new Uint8Array(4) },
        { base_url: `${src.base}/v1`, headers: { 'xi-api-key': 'sk-not-a-real-key' } },
        'scribe_v1',
        fetch,
      ),
    ).rejects.toThrow()
    expect(src.requestLog.length).toBeGreaterThan(0)
    expect(dest.requestLog).toHaveLength(0)
  } finally {
    src.stop()
    dest.stop()
  }
})
