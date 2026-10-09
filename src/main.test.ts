import { expect, test } from 'bun:test'
import { createLlamaDoor, llamaDoorConfig, makeLlamaHttpClient } from './doorFixtures.ts'
import { errorMessageOf, JSON_CONTENT_TYPE } from './http.ts'
import { bindDualFamily } from './listen.ts'
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
    v6?.stop()
  }
})

test('a host without loopback IPv6 is served on 127.0.0.1 alone', () => {
  const calls: string[] = []
  const serve = ((opts: { hostname: string; port: number }) => {
    calls.push(opts.hostname)
    if (opts.hostname === '::1') {
      throw Object.assign(new Error('address not available'), { code: 'EADDRNOTAVAIL' })
    }
    return { port: 4242, stop: () => undefined }
  }) as unknown as typeof Bun.serve
  const { v4, v6 } = bindDualFamily(() => new Response(), 0, serve)
  expect(calls).toEqual(['127.0.0.1', '::1'])
  expect(v4.port).toBe(4242)
  expect(v6).toBeUndefined()
})

test('engined binds in a network namespace with loopback IPv6 disabled', () => {
  const listen = new URL('./listen.ts', import.meta.url).pathname
  const script = `const {v4,v6}=require(${JSON.stringify(listen)}).bindDualFamily(()=>new Response('ok'),0);console.log(v6===undefined?'v4-only':'dual');v4.stop(true)`
  const run = Bun.spawnSync(
    [
      'unshare',
      '-rn',
      'sh',
      '-c',
      'echo 1 > /proc/sys/net/ipv6/conf/lo/disable_ipv6 && exec "$0" -e "$1"',
      process.execPath,
      script,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  if (run.exitCode !== 0 && run.stdout.length === 0) {
    return // no unprivileged user namespaces on this host
  }
  expect(run.stdout.toString().trim()).toBe('v4-only')
  expect(run.stderr.toString()).toContain('::1 unavailable')
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
