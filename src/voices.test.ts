import { expect, test } from 'bun:test'
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redirectStateHome } from './enginesFixtures.ts'
import { errorMessageOf } from './http.ts'
import { voicesDir } from './paths.ts'
import { makeTestRoot } from './test-support.ts'
import { handleVoiceUpload, resolveVoice, VOICE_CONTAINER_DIR } from './voices.ts'

const TEST_ROOT = makeTestRoot('engined-voices-')
const CLIP = Buffer.from('RIFF0000WAVEfmt ', 'utf8')

function upload(name: string, bytes: Buffer = CLIP): Promise<Response> {
  const form = new FormData()
  form.set('file', new File([bytes], name))
  return handleVoiceUpload(
    new Request('http://engined/engined/v1/audio/voices', { method: 'POST', body: form }),
  )
}

test('an upload is named by the door, a baked-in voice is passed through, and a handle this door did not issue is refused', async () => {
  const restore = redirectStateHome(TEST_ROOT)
  try {
    const missing = await handleVoiceUpload(
      new Request('http://engined/engined/v1/audio/voices', {
        method: 'POST',
        body: 'not-multipart',
      }),
    )
    expect(missing.status).toBe(400)
    expect(errorMessageOf(await missing.json())).toContain('`file` part')

    const empty = await upload('empty.wav', Buffer.alloc(0))
    expect(empty.status).toBe(400)
    expect(errorMessageOf(await empty.json())).toContain('no `file` part')

    const png = await upload('clip.PNG')
    expect(png.status).toBe(200)
    const { voice, bytes } = (await png.json()) as { voice: string; bytes: number }
    expect(voice).toMatch(/^vc_[0-9a-f]{32}\.png$/)
    expect(bytes).toBe(CLIP.byteLength)
    expect(resolveVoice(voice)).toBe(`${VOICE_CONTAINER_DIR}/${voice}`)

    const noExt = await upload('reference')
    expect(noExt.status).toBe(200)
    const { voice: wav } = (await noExt.json()) as { voice: string }
    expect(wav).toMatch(/^vc_[0-9a-f]{32}\.wav$/)

    expect(resolveVoice(undefined)).toBeUndefined()
    expect(resolveVoice('alloy')).toBe('alloy')

    const malformed = resolveVoice('vc_../../etc/passwd')
    expect(malformed).toBeInstanceOf(Response)
    expect((malformed as Response).status).toBe(400)

    const missingHandle = resolveVoice(`vc_${'0'.repeat(32)}.wav`)
    expect(missingHandle).toBeInstanceOf(Response)
    expect((missingHandle as Response).status).toBe(400)
    expect(errorMessageOf(await (missingHandle as Response).json())).toContain('not held')
  } finally {
    restore()
  }
})

test('a store past 64 uploads drops the least-recently used file, not the one a later resolve just touched', async () => {
  const restore = redirectStateHome(TEST_ROOT)
  try {
    const dir = voicesDir()
    mkdirSync(dir, { recursive: true })
    const now = Date.now()
    const names = Array.from({ length: 64 }, (_, i) => `vc_${i.toString(16).padStart(32, '0')}.wav`)
    for (const [i, name] of names.entries()) {
      writeFileSync(join(dir, name), CLIP)
      const used = new Date(now - (64 - i) * 1000)
      utimesSync(join(dir, name), used, used)
    }
    expect(resolveVoice(names[0])).toBe(`${VOICE_CONTAINER_DIR}/${names[0]}`)

    const added = await upload('fresh.wav')
    expect(added.status).toBe(200)
    const { voice } = (await added.json()) as { voice: string }
    const held = new Set(readdirSync(dir))
    expect(held.size).toBe(64)
    expect(held.has(names[0] as string)).toBe(true)
    expect(held.has(names[1] as string)).toBe(false)
    expect(held.has(voice)).toBe(true)
  } finally {
    restore()
  }
})
