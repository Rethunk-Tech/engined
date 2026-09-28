import { expect, test } from 'bun:test'
import { createLlamaDoor, llamaDoorConfig, makeLlamaHttpClient } from './doorFixtures.ts'
import { errorMessageOf, JSON_CONTENT_TYPE } from './http.ts'
import { bindDualFamily } from './main.ts'
import { makeTestRoot } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-main-')

test("Bun.serve's error handler answers JSON 500, not the HTML diagnostic page", async () => {
  const { v4, v6 } = bindDualFamily(() => {
    throw new Error('boom')
  }, 0)
  try {
    const res = await fetch(`http://127.0.0.1:${v4.port}/`)
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain(JSON_CONTENT_TYPE)
    expect(errorMessageOf(await res.json())).toBe('boom')
  } finally {
    v4.stop()
    v6.stop()
  }
})

test('Sec-Fetch-Site other than none or same-origin is refused even with no Origin', async () => {
  const { cfg, root } = llamaDoorConfig(TEST_ROOT)
  const door = createLlamaDoor(cfg, root, {
    llamaHttpClient: makeLlamaHttpClient([]),
    write: () => undefined,
  })
  const models = 'http://engined/openai/v1/models'
  const cross = await door.fetch(
    new Request(models, { headers: { 'Sec-Fetch-Site': 'cross-site' } }),
  )
  expect(cross.status).toBe(403)
  const sameSite = await door.fetch(
    new Request(models, { headers: { 'Sec-Fetch-Site': 'same-site' } }),
  )
  expect(sameSite.status).toBe(403)
  const none = await door.fetch(new Request(models, { headers: { 'Sec-Fetch-Site': 'none' } }))
  expect(none.status).toBe(200)
  const sameOrigin = await door.fetch(
    new Request(models, { headers: { 'Sec-Fetch-Site': 'same-origin' } }),
  )
  expect(sameOrigin.status).toBe(200)
  const absent = await door.fetch(new Request(models))
  expect(absent.status).toBe(200)
})
