import { expect, test } from 'bun:test'
import { createLlamaDoor, llamaDoorConfig } from './doorFixtures.ts'
import { runProbes } from './probe.ts'
import { PROBES_PATH } from './probeStore.ts'
import type { EnginesResponse, ModelsResponse } from './responses.ts'
import { makeTestRoot } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-probes-')
const ADDRESS = '@/local-llama/ornith'

function setup() {
  const { cfg, root } = llamaDoorConfig(TEST_ROOT)
  const door = createLlamaDoor(cfg, root)
  const post = (body: unknown) =>
    door.fetch(
      new Request(`http://engined${PROBES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  const engines = async (): Promise<EnginesResponse> =>
    (
      await door.fetch(new Request('http://engined/engined/v1/engines'))
    ).json() as Promise<EnginesResponse>
  const models = async (): Promise<ModelsResponse> =>
    (
      await door.fetch(new Request('http://engined/openai/v1/models'))
    ).json() as Promise<ModelsResponse>
  return { door, post, engines, models }
}

test('before any probe is reported, neither listing carries a probe field', async () => {
  const { engines, models } = setup()

  expect((await engines()).engines[0]?.probes).toBeUndefined()
  expect((await models()).data[0]?.probe).toBeUndefined()
})

test('a reported failing probe shows on the engine and on the model row, beside an unset last_error', async () => {
  const { post, engines, models } = setup()

  const res = await post({
    results: [{ address: ADDRESS, kind: 'rerank', quality: false, detail: 'ranked index 0 first' }],
  })

  expect(res.status).toBe(200)
  const engine = (await engines()).engines.find((e) => e.id === 'local-llama')
  expect(engine?.probes).toEqual([
    {
      address: ADDRESS,
      kind: 'rerank',
      quality: false,
      detail: 'ranked index 0 first',
      at: expect.any(String),
    },
  ])
  expect(engine?.last_error).toBeUndefined()
  const row = (await models()).data.find((r) => r.id === ADDRESS)
  expect(row?.probe).toMatchObject({ kind: 'rerank', quality: false })
})

test('a batch naming an address no route answers for is a 400 and records nothing', async () => {
  const { post, models } = setup()

  const res = await post({
    results: [
      { address: ADDRESS, kind: 'translation', quality: true, detail: 'ok' },
      { address: '@/nowhere/none', kind: 'rerank', quality: true, detail: 'ok' },
    ],
  })

  expect(res.status).toBe(400)
  expect((await models()).data.find((r) => r.id === ADDRESS)?.probe).toBeUndefined()
})

test('runProbes reports its rerank verdict to the door it probed', async () => {
  const posted: unknown[] = []
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/engined/v1/engines')) {
      return Promise.resolve(Response.json({ contract: 6, engines: [] }))
    }
    if (url.endsWith('/openai/v1/models')) {
      return Promise.resolve(
        Response.json({
          data: [{ id: '@/llama/rerank', role: 'rerank', state: 'installed' }],
        }),
      )
    }
    if (url.endsWith(PROBES_PATH)) {
      posted.push(JSON.parse(String(init?.body)))
      return Promise.resolve(Response.json({ recorded: 1 }))
    }
    return Promise.resolve(Response.json({ results: [{ index: 0 }] }))
  }) as typeof fetch

  const report = await runProbes('http://door', fetchImpl)

  expect(report.ok).toBe(false)
  expect(posted).toEqual([
    {
      results: [
        {
          address: '@/llama/rerank',
          kind: 'rerank',
          quality: false,
          detail: expect.stringContaining('index 0'),
        },
      ],
    },
  ])
})
