import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { createDoor } from './main.ts'
import { BUNX, config, engine, makeTestRoot, writeEngineSpec } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-obtain-')

function spec(artifacts: string): string {
  return [
    'kind = "tts"',
    'upstream = "self"',
    'image = "probe:local"',
    'obtain = "build"',
    'serves = ["/openai/v1/audio/speech"]',
    'command = []',
    '',
    artifacts,
    '[ready]',
    'path   = "/health"',
    'status = 200',
  ].join('\n')
}

const post = (id: string) =>
  new Request(`http://127.0.0.1:29200/engined/v1/engines/${id}/obtain`, { method: 'POST' })

test('obtain streams the missing artifact commands, skips what is present, and refuses a second run', async () => {
  const root = mkdtempSync(join(TEST_ROOT, 'engines-'))
  const models = mkdtempSync(join(TEST_ROOT, 'models-'))
  const volume = `[[volume]]\nname = "${models}"\npath = "/models"\n`
  writeEngineSpec(
    root,
    'fetcher',
    spec(
      `${volume}[[artifact]]\npath = "/models/out.txt"\nobtain = "printf 'hello\\\\n' > ${models}/out.txt; echo fetched; echo warn >&2"\n`,
    ),
  )
  writeEngineSpec(
    root,
    'slow',
    spec(
      `${volume}[[artifact]]\npath = "/models/slow.txt"\nobtain = "sleep 0.4; printf x > ${models}/slow.txt"\n`,
    ),
  )
  writeEngineSpec(root, 'bare', spec(''))
  const door = createDoor(
    config({
      engines: [engine({ id: 'fetcher' }), engine({ id: 'slow' }), engine({ id: 'bare' })],
    }),
    { enginesRoot: root, bunx: BUNX },
    { usageStateRoot: join(TEST_ROOT, 'usage') },
  )

  const ran = await door.fetch(post('fetcher'))
  expect(ran.headers.get('content-type')).toBe('text/event-stream')
  const body = await ran.text()
  expect(body).toContain('event: line\ndata: {"step":0,"stream":"stdout","line":"fetched"}')
  expect(body).toContain('"stream":"stderr","line":"warn"')
  expect(body).toContain('event: exit\ndata: {"exitCode":0,"steps":1}')
  expect(existsSync(join(models, 'out.txt'))).toBe(true)

  const again = await (await door.fetch(post('fetcher'))).text()
  expect(again).toContain('event: exit\ndata: {"exitCode":0,"steps":0}')

  expect((await door.fetch(post('bare'))).status).toBe(404)
  expect((await door.fetch(post('nobody'))).status).toBe(404)

  const first = await door.fetch(post('slow'))
  expect((await door.fetch(post('slow'))).status).toBe(409)
  expect(await first.text()).toContain('"exitCode":0')
  expect((await door.fetch(post('slow'))).status).toBe(200)
})
