/**
 * What the door does to the text it carries in either direction: the markup a
 * TTS engine would otherwise vocalize, and the bias vocabulary whisper's
 * window cannot hold -- decided once for every consumer rather than once per
 * consumer, differently.
 */
import { expect, test } from 'bun:test'
import { handleSpeech, resetSpeechCache } from './audioSpeech.ts'
import { handleTranscription } from './audioTranscribe.ts'
import { startFakeUpstream } from './test-support.ts'

const SAMPLE_WAV_BASE64 = Buffer.from('RIFF____WAVEfmt ', 'utf8').toString('base64')

/** A real `Bun.serve` TTS engine emitting one terminal NDJSON frame, recording the `text` it was sent. */
function startFakeTts(): { base: string; texts: string[]; stop: () => void } {
  const texts: string[] = []
  const fake = startFakeUpstream(async (req) => {
    const body: unknown = await req.json()
    texts.push(typeof body === 'object' && body !== null && 'text' in body ? String(body.text) : '')
    return new Response(`${JSON.stringify({ phase: 'done', audio: SAMPLE_WAV_BASE64 })}\n`, {
      headers: { 'content-type': 'application/x-ndjson' },
    })
  })
  return { base: `127.0.0.1:${fake.port}`, texts, stop: fake.stop }
}

/**
 * The one text the fake engine was sent. Resets the synthesis cache first: two
 * inputs that differ only in markup are one utterance after normalization, so
 * the second would be served from the first's rendition and reach no engine at
 * all -- which is the cache working, and would leave this helper with nothing
 * to report.
 */
async function spokenText(input: string): Promise<string> {
  resetSpeechCache()
  const fake = startFakeTts()
  const res = await handleSpeech({ engine: 'chatterbox-en', input }, async () => ({
    private_url: fake.base,
  }))
  fake.stop()
  return res.status === 200 ? (fake.texts[0] ?? '') : `status ${res.status}`
}

test('bold and a bare URL reach the engine as words, which is what the 3.5x and 2.2x buy back', async () => {
  expect(await spokenText('**Ready** in a moment')).toBe('Ready in a moment')
  expect(await spokenText('See https://example.com for the rest')).toBe(
    'See example dot com for the rest',
  )
  expect(await spokenText('Read [the notes](https://example.com/notes) first')).toBe(
    'Read the notes first',
  )
})

test('a heading or list marker is markup, and the words after it are not', async () => {
  expect(await spokenText('# Status\n- one\n- two')).toBe('Status\none\ntwo')
})

test('already-plain text reaches the engine byte-identical, so a caller that normalizes is not normalized twice', async () => {
  const plain = 'Priya asked about some_var and `npm run build` at 3.5 percent.'
  expect(await spokenText(plain)).toBe(plain)
  // The pass is idempotent: what a first pass produces is what a second one
  // would, so the door and a normalizing caller cannot disagree.
  expect(await spokenText('See https://example.com for **the rest**')).toBe(
    await spokenText('See example dot com for the rest'),
  )
})

test('an input that was nothing but markup is a 400, not an empty utterance the engine has to explain', async () => {
  const res = await handleSpeech({ engine: 'chatterbox-en', input: '**' }, () => {
    throw new Error('no engine should be started for an unspeakable input')
  })

  expect(res.status).toBe(400)
})

/** A real `Bun.serve` whisper, recording the `prompt` each path sent: the form field, or the streamed route's query string. */
function startFakeWhisper(): {
  base: string
  prompts: Array<string | undefined>
  stop: () => void
} {
  const prompts: Array<string | undefined> = []
  const fake = startFakeUpstream(async (req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/stream')) {
      await req.arrayBuffer()
      prompts.push(url.searchParams.get('prompt') ?? undefined)
      return new Response(`${JSON.stringify({ phase: 'done', text: 'hello world' })}\n`, {
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }
    const value = (await req.formData()).get('prompt')
    prompts.push(typeof value === 'string' ? value : undefined)
    return Response.json({ text: 'hello world' })
  })
  return { base: `127.0.0.1:${fake.port}`, prompts, stop: fake.stop }
}

const SAMPLE_AUDIO_BYTES = new Uint8Array([1, 2, 3, 4])

/** The one `prompt` the fake whisper was sent for this request. */
async function biasPromptSent(prompt: string, stream?: true): Promise<string | undefined> {
  const fake = startFakeWhisper()
  await handleTranscription(
    { engine: 'whisper', file: SAMPLE_AUDIO_BYTES, prompt, stream },
    async () => ({
      private_url: fake.base,
    }),
  )
  fake.stop()
  return fake.prompts[0]
}

/** `term1 .. termN`, oldest first, the order a corrections list is appended in. */
function terms(count: number): string[] {
  return Array.from({ length: count }, (_unused, i) => `term${i + 1}`)
}

test("an over-cap prompt keeps the newest 24 terms, in the caller's order", async () => {
  const sent = await biasPromptSent(terms(30).join(', '))

  expect(sent).toBe(terms(30).slice(6).join(', '))
})

test('a prompt already under the cap reaches the engine unchanged', async () => {
  expect(await biasPromptSent('Priya, nginx, marmoset')).toBe('Priya, nginx, marmoset')
})

test("a term longer than the window's share is clipped, and a duplicate spends no room", async () => {
  const phrase = 'x'.repeat(60)

  expect(await biasPromptSent(`${phrase}, nginx, NGINX`)).toBe(`${'x'.repeat(40)}, NGINX`)
})

test('a prompt with nothing usable in it is no prompt, not a blank initial prompt', async () => {
  expect(await biasPromptSent('  ,  , ')).toBeUndefined()
})

test('the streamed route caps the same way the buffered one does', async () => {
  const sent = await biasPromptSent(terms(30).join(', '), true)

  expect(sent).toBe(terms(30).slice(6).join(', '))
})

/** One fake engine, and a call against it that reports how many times it has actually synthesized. */
function speechRuns() {
  resetSpeechCache()
  const fake = startFakeTts()
  const say = (req: Partial<Parameters<typeof handleSpeech>[0]> = {}) =>
    handleSpeech({ engine: 'chatterbox-en', input: 'Ready.', ...req }, async () => ({
      private_url: fake.base,
    }))
  return { say, calls: () => fake.texts.length, stop: fake.stop }
}

test('the same utterance is synthesized once, and the second caller gets the same bytes', async () => {
  const { say, calls, stop } = speechRuns()
  const first = await say()
  const second = await say()
  stop()

  expect(calls()).toBe(1)
  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(second.bytes).toEqual(first.bytes)
})

test('markup is not a second utterance: what normalizes alike shares one rendition', async () => {
  const { say, calls, stop } = speechRuns()
  await say({ input: '**Ready.**' })
  await say({ input: 'Ready.' })
  stop()

  // The key is the normalized text, so these are one utterance -- the pair
  // `speakableText` exists to make identical would otherwise miss each other.
  expect(calls()).toBe(1)
})

test('anything that changes the audio changes the key', async () => {
  for (const differing of [
    { voice: 'vc_00000000000000000000000000000000.wav' },
    { speed: 1.5 },
    { instructions: 'whisper it' },
    { engine: 'chatterbox-multi' },
  ]) {
    const { say, calls, stop } = speechRuns()
    await say()
    await say(differing)
    stop()

    expect({ differing, calls: calls() }).toEqual({ differing, calls: 2 })
  }
})

test('a streamed reply is frames, not a body, so it is never cached', async () => {
  const { say, calls, stop } = speechRuns()
  await say({ stream: true })
  await say({ stream: true })
  const buffered = await say()
  stop()

  // Three engine calls: neither streamed request was served from cache, and
  // neither left an entry for the buffered one to find.
  expect(calls()).toBe(3)
  expect(buffered.status).toBe(200)
})
