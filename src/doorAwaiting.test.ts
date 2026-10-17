import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { awaitingConfig } from './configAwaiting.ts'
import { errorMessageOf } from './http.ts'
import { createDoor } from './main.ts'
import { BUNX, makeTestRoot } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-awaiting-')

function awaitingDoor(path: string) {
  const door = createDoor(
    awaitingConfig(29_200),
    { enginesRoot: '/nonexistent', bunx: BUNX },
    { awaitingConfigError: 'no config yet', usageStateRoot: join(TEST_ROOT, 'usage') },
  )
  door.reload(path)
  return door
}

const get = (path: string) => new Request(`http://127.0.0.1:29200${path}`)

test('a door with no config answers 503 with config_error until a reload loads a valid one', async () => {
  const path = join(TEST_ROOT, 'config.toml')
  const door = awaitingDoor(path)
  const refused = await door.fetch(get('/openai/v1/models'))
  expect(refused.status).toBe(503)
  expect(errorMessageOf(await refused.json())).toContain('cannot read config')
  const listing = await (await door.fetch(get('/engined/v1/engines'))).json()
  expect((listing as { config_error: string }).config_error).toContain('cannot read config')

  await Bun.write(path, 'listen_port = 29200\n')
  door.reload(path)
  expect((await door.fetch(get('/openai/v1/models'))).status).toBe(200)
  expect(door.configError()).toBeUndefined()
})
