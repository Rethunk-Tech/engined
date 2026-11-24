/**
 * `POST /history` erase mediation, beside the rest of the comfy proxy suite.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { redirectStateHome } from './enginesFixtures.ts'
import type { HttpClient } from './http.ts'
import { createDoor } from './main.ts'
import {
  BUNX,
  buildExec,
  config,
  engine,
  makeTestRoot,
  route,
  writeEngineSpec,
} from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-comfy-erase-')
afterAll(redirectStateHome(TEST_ROOT))

const COMFY_SPEC = `
kind = "comfy"
upstream = "self"
image = "engined/fakecomfy:local"
obtain = "build"
serves = []
command = []

[ready]
path = "/queue"
status = 200
`

const COMFY_CONTAINER_PORT = 8188
const PROXY_PATH = '/engined/v1/comfy/comfy/local'

async function comfyDoor(comfyHttpClient: HttpClient, execLog?: string[][]) {
  process.env.XDG_STATE_HOME = mkdtempSync(join(TEST_ROOT, 'comfy-state-'))
  const root = mkdtempSync(join(TEST_ROOT, 'door-'))
  writeEngineSpec(root, 'comfy', COMFY_SPEC)
  const door = createDoor(
    config({
      engines: [engine({ id: 'comfy', models_dir: '/data/comfy', idle_stop_seconds: 9999 })],
      routes: [route({ engine: 'comfy', model: undefined, upstream: 'local' })],
    }),
    {
      enginesRoot: root,
      bunx: BUNX,
      exec: buildExec({ port: 40_999, containerPort: COMFY_CONTAINER_PORT, execLog }),
      probe: () => Promise.resolve({ status: 200 }),
    },
    { comfyHttpClient },
  )
  await door.registry.start('comfy')
  return door
}

function idleQueue(): Response {
  return Response.json({ queue_running: [], queue_pending: [] })
}

function isQueueRead(url: string, init?: RequestInit): boolean {
  return url.includes('/queue') && init?.method !== 'POST'
}

function recordingComfyClient(
  respond: (url: string, init?: RequestInit) => Promise<Response> | Response,
): { client: HttpClient; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = []
  const client: HttpClient = async (url, init) => {
    calls.push({ url, init })
    return await respond(url, init)
  }
  return { client, calls }
}

function recordingPromptClient(
  promptId: string,
  extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined,
): ReturnType<typeof recordingComfyClient> {
  return recordingComfyClient((url, init) => {
    if (isQueueRead(url, init)) {
      return idleQueue()
    }
    if (url.includes('/prompt')) {
      return Response.json({ prompt_id: promptId })
    }
    return extra(url, init) ?? Response.json({})
  })
}

describe("comfy proxy: POST /history erases this origin's finished prompts", () => {
  test('an unbound id is never forwarded', async () => {
    const { client, calls } = recordingComfyClient(() => new Response('should never be reached'))
    const door = await comfyDoor(client)
    const res = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/history`, {
        method: 'POST',
        body: JSON.stringify({ delete: ['never-submitted'] }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: [], uploads: [] })
    expect(calls.filter((c) => c.url.includes('/history') && c.init?.method === 'POST')).toEqual([])
  })

  test('a bound id is forwarded, its binding is gone afterwards, and a later GET /view for its file is refused', async () => {
    const { client, calls } = recordingPromptClient('job-erase', (url, init) => {
      if (url.includes('/history/') && init?.method !== 'POST') {
        return Response.json({
          'job-erase': {
            outputs: { '9': { images: [{ filename: 'out.png', type: 'temp' }] } },
          },
        })
      }
      if (url.endsWith('/history') && init?.method === 'POST') {
        return Response.json({})
      }
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
    })
    const door = await comfyDoor(client)
    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )
    await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-erase`))
    const viewed = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=out.png`),
    )
    expect(viewed.status).toBe(200)

    const erased = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/history`, {
        method: 'POST',
        body: JSON.stringify({ delete: ['job-erase'] }),
      }),
    )
    expect(erased.status).toBe(200)
    expect(await erased.json()).toEqual({ deleted: ['job-erase'], uploads: [] })
    const forwarded = calls.filter((c) => c.url.endsWith('/history') && c.init?.method === 'POST')
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]?.init?.body).toBe(JSON.stringify({ delete: ['job-erase'] }))

    const laterHistory = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/history/job-erase`),
    )
    expect(laterHistory.status).toBe(404)
    const laterView = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=out.png`),
    )
    expect(laterView.status).toBe(404)
  })

  test('an upload name this origin never sent as temp is never deleted', async () => {
    const { client } = recordingComfyClient(async (_url, init) => {
      const form = await (init?.body as FormData)
      const image = form.get('image') as File
      return Response.json({ name: image.name, subfolder: '', type: form.get('type') })
    })
    const execLog: string[][] = []
    const door = await comfyDoor(client, execLog)
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array([1, 2, 3])]), 'reference.png')
    const uploaded = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/upload/image`, { method: 'POST', body: form }),
    )
    const name = ((await uploaded.json()) as { name: string }).name
    const res = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/history`, {
        method: 'POST',
        body: JSON.stringify({ uploads: [name, 'stranger.png'] }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: [], uploads: [] })
    expect(execLog.some((argv) => argv.includes('rm') && argv.some((a) => a.endsWith(name)))).toBe(
      false,
    )
    expect(execLog.some((argv) => argv.some((a) => a.endsWith('stranger.png')))).toBe(false)
  })
})
