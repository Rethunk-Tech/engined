/**
 * `POST /engined/v1/comfy/:engine/:upstream/...`: the mediated comfy proxy.
 * Everything here treats the real container as a stand-in dependency,
 * injected the same way `llamaHttpClient`/`extrasHttpClient` already are --
 * except the websocket bridge, which needs a real socket to prove anything
 * at all, so that one test binds a real door against a real fake container.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { comfyBindingsPath, loadComfyBindings } from './comfyBindings.ts'
import { loadConfig } from './config.ts'
import { redirectStateHome } from './enginesFixtures.ts'
import {
  errorMessageOf,
  type HttpClient,
  jsonErrorBody,
  MAX_JSON_BODY_BYTES,
  STATUS_BAD_REQUEST,
  STATUS_CLIENT_CLOSED,
  STATUS_PAYLOAD_TOO_LARGE,
} from './http.ts'
import { bindDualFamily, createDoor } from './main.ts'
import {
  BUNX,
  buildExec,
  collectLines,
  config,
  deadPort,
  engine,
  makeTestRoot,
  route,
  writeEngineSpec,
} from './test-support.ts'
import type { EngineEntry } from './types.ts'

const TEST_ROOT = makeTestRoot('engined-comfy-proxy-')
afterAll(redirectStateHome(TEST_ROOT))

const RX_DRAIN_TIMEOUT_POSITIVE = /"drain_timeout_seconds" must be greater than 0/

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

/** ComfyUI's own listen port, which its image is the one to `EXPOSE`. */
const COMFY_CONTAINER_PORT = 8188

const PROXY_PATH = '/engined/v1/comfy/comfy/local'
/** A real ComfyUI node type: the proxy must forward the segment untouched, so the test needs one that actually exists. */
const NODE_TYPE = 'KSampler'

/**
 * A running comfy engine, ready to proxy through -- `port` need not answer
 * anything real when `comfyHttpClient` intercepts every forwarded call. The
 * binding table lives under `XDG_STATE_HOME`, so each door gets a fresh table
 * unless the caller names one to reopen.
 */
async function comfyDoor(
  comfyHttpClient?: HttpClient,
  port = 40_999,
  stateHome?: string,
  engineOverrides: Partial<EngineEntry> = {},
) {
  process.env.XDG_STATE_HOME = stateHome ?? mkdtempSync(join(TEST_ROOT, 'comfy-state-'))
  const root = mkdtempSync(join(TEST_ROOT, 'door-'))
  writeEngineSpec(root, 'comfy', COMFY_SPEC)
  const cfg = config({
    engines: [
      engine({
        id: 'comfy',
        models_dir: '/data/comfy',
        idle_stop_seconds: 9999,
        ...engineOverrides,
      }),
    ],
    routes: [route({ engine: 'comfy', model: undefined, upstream: 'local' })],
  })
  const door = createDoor(
    cfg,
    {
      enginesRoot: root,
      bunx: BUNX,
      exec: buildExec({ port, containerPort: COMFY_CONTAINER_PORT }),
      probe: () => Promise.resolve({ status: 200 }),
    },
    { comfyHttpClient },
  )
  await door.registry.start('comfy')
  return door
}

/**
 * The container's answer for "holding nothing at all". `POST /prompt` reads
 * the queue before it forwards -- the door submits one prompt at a time -- so
 * every fake that expects a submission to land has to say the container is
 * free, and a fake that says nothing readable is correctly made to wait.
 */
function idleQueue(): Response {
  return Response.json({ queue_running: [], queue_pending: [] })
}

/** Whether this forwarded call is the door reading the container's queue, rather than deleting from it. */
function isQueueRead(url: string, init?: RequestInit): boolean {
  return url.includes('/queue') && init?.method !== 'POST'
}

/** Records every call a fake comfy container's `HttpClient` receives, answering with `respond`'s own per-URL logic. */
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

async function unreachedUpload(headers: Record<string, string>, body: string) {
  const { client, calls } = recordingComfyClient(() => new Response('should never be reached'))
  const door = await comfyDoor(client)
  const res = await door.fetch(
    new Request(`http://engined${PROXY_PATH}/upload/image`, {
      method: 'POST',
      headers,
      body,
    }),
  )
  return { res, calls }
}

async function refusedCancel(res: Response) {
  const body = (await res.json()) as { error?: string; cancelled?: string }
  expect(res.status).toBe(502)
  expect(body.cancelled).toBeUndefined()
  expect(errorMessageOf(body)).toContain('http 500')
}

async function expectJobCCancelled(
  res: Response,
  cancelled: 'running' | 'pending',
  calls: { url: string; init?: RequestInit }[],
  interruptCount: number,
) {
  expect(await res.json()).toEqual({ prompt_id: 'job-c', cancelled })
  expect(calls.filter((c) => c.url.includes('/interrupt'))).toHaveLength(interruptCount)
}

function jobCDuringDeleteClient(onQueueRead: (reads: number) => Response, withInterrupt: boolean) {
  let reads = 0
  return recordingComfyClient((url, init) => {
    if (url.includes('/prompt')) {
      return Response.json({ prompt_id: 'job-c' })
    }
    if (withInterrupt && url.includes('/interrupt')) {
      return Response.json({})
    }
    if (isQueueRead(url, init)) {
      reads += 1
      return onQueueRead(reads)
    }
    return Response.json({})
  })
}

describe('comfy proxy: forwarded as-is', () => {
  test('GET object_info/{nodeType} is forwarded verbatim', async () => {
    const { client, calls } = recordingComfyClient(() =>
      Response.json({
        [NODE_TYPE]: { input: { required: { seed: [['INT']] } } },
      }),
    )
    const door = await comfyDoor(client)
    const res = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/object_info/${NODE_TYPE}`),
    )
    expect(res.status).toBe(200)
    expect(calls[0]?.url).toContain(`/object_info/${NODE_TYPE}`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body[NODE_TYPE]).toBeDefined()
  })

  test('GET system_stats is forwarded verbatim', async () => {
    const { client, calls } = recordingComfyClient(() => Response.json({ system: { os: 'posix' } }))
    const door = await comfyDoor(client)
    const res = await door.fetch(new Request(`http://engined${PROXY_PATH}/system_stats`))
    expect(res.status).toBe(200)
    expect(calls[0]?.url).toContain('/system_stats')
  })
})

describe('comfy proxy: POST /prompt binds the result, POST /upload/image namespaces it', () => {
  test("a submitted prompt's id becomes known to this door, and nothing else", async () => {
    const { client } = recordingComfyClient(() => Response.json({ prompt_id: 'job-1', number: 1 }))
    const door = await comfyDoor(client)
    const res = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ prompt: {}, client_id: 'whatever' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { prompt_id: string }).prompt_id).toBe('job-1')
  })

  test('a prompt body that is cut off or too large never reaches comfy', async () => {
    const { client, calls } = recordingPromptClient('job-1')
    const door = await comfyDoor(client)
    const cutOff: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('client hung up'))
        },
      }),
    }
    const aborted = await door.fetch(new Request(`http://engined${PROXY_PATH}/prompt`, cutOff))
    expect(aborted.status).toBe(STATUS_BAD_REQUEST)
    const huge = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, {
        method: 'POST',
        headers: { 'content-length': String(MAX_JSON_BODY_BYTES + 1) },
      }),
    )
    expect(huge.status).toBe(STATUS_PAYLOAD_TOO_LARGE)
    expect(calls).toEqual([])
  })

  test("an uploaded filename reaches comfy renamed, never the caller's literal name", async () => {
    const { client, calls } = recordingComfyClient(async (_url, init) => {
      const form = await (init?.body as FormData)
      const image = form.get('image') as File
      return Response.json({ name: image.name, subfolder: '', type: 'input' })
    })
    const door = await comfyDoor(client)
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array([1, 2, 3])]), 'reference.png')
    const res = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/upload/image`, { method: 'POST', body: form }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { name: string }
    expect(body.name).not.toBe('reference.png')
    expect(body.name.endsWith('reference.png')).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test('an oversized upload is 413 before it is forwarded', async () => {
    const { res, calls } = await unreachedUpload({ 'content-length': String(33_554_433) }, 'x')
    expect(res.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  test('a chunked upload with no Content-Length is 413 at the cap, not after reading it whole', async () => {
    const { client, calls } = recordingComfyClient(() => new Response('should never be reached'))
    const door = await comfyDoor(client)
    const chunk = new Uint8Array(1024 * 1024)
    let pulled = 0
    const sent = 33_554_432 + 16 * chunk.byteLength
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= sent) {
          controller.close()
          return
        }
        pulled += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      duplex: 'half',
      headers: { 'content-type': 'multipart/form-data; boundary=----x' },
      body,
    }
    const res = await door.fetch(new Request(`http://engined${PROXY_PATH}/upload/image`, init))
    expect(res.status).toBe(413)
    expect(calls).toHaveLength(0)
    // The stream may run a chunk or two ahead of the reader, never far.
    expect(pulled).toBeLessThanOrEqual(33_554_432 + 4 * chunk.byteLength)
  })

  test('a malformed upload body is 400 before it is forwarded', async () => {
    const { res, calls } = await unreachedUpload(
      { 'content-type': 'multipart/form-data; boundary=----x' },
      'this is not a multipart body',
    )
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('comfy proxy: GET /view is mediated', () => {
  test('a filename no completed job produced is refused byte-identically, whether or not it exists on disk', async () => {
    const { client, calls } = recordingComfyClient(() => new Response('should never be reached'))
    const door = await comfyDoor(client)
    const neverKnown = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=nothing-like-this-exists.png`),
    )
    const alsoNeverKnown = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=some-other-name.png`),
    )
    expect(neverKnown.status).toBe(alsoNeverKnown.status)
    expect(await neverKnown.text()).toBe(await alsoNeverKnown.text())
    // Refused before ever reaching comfy -- the mediation checks this door's
    // own known-filenames set, never the container's disk.
    expect(calls).toHaveLength(0)
  })

  test('a filename a completed history read actually surfaced is served', async () => {
    const { client } = recordingPromptClient('job-2', (url) => {
      if (url.includes('/history/')) {
        return Response.json({
          'job-2': {
            outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
          },
        })
      }
      if (url.includes('/view')) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'content-type': 'image/png' },
        })
      }
      return new Response('unexpected', { status: 500 })
    })
    const door = await comfyDoor(client)

    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )
    await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-2`))
    const viewed = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=out.png&subfolder=&type=output`),
    )

    expect(viewed.status).toBe(200)
    expect(viewed.headers.get('content-type')).toBe('image/png')
  })

  test('GET /view forwards only the history-recorded filename, subfolder, and type', async () => {
    const { client, calls } = recordingPromptClient('job-q', (url) => {
      if (url.includes('/history/')) {
        return Response.json({
          'job-q': {
            outputs: {
              '9': { images: [{ filename: 'out.png', subfolder: 'renders', type: 'output' }] },
            },
          },
        })
      }
      if (url.includes('/view')) {
        return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
      }
      return new Response('unexpected', { status: 500 })
    })
    const door = await comfyDoor(client)

    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )
    await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-q`))
    const viewed = await door.fetch(
      new Request(
        `http://engined${PROXY_PATH}/view?filename=out.png&subfolder=evil&type=input&preview=1`,
      ),
    )

    expect(viewed.status).toBe(200)
    const forwarded = calls.filter((c) => c.url.includes('/view'))
    expect(forwarded).toHaveLength(1)
    const q = new URLSearchParams(forwarded[0]?.url.split('?')[1] ?? '')
    expect(q.get('filename')).toBe('out.png')
    expect(q.get('subfolder')).toBe('renders')
    expect(q.get('type')).toBe('output')
    expect(q.get('preview')).toBeNull()
    expect([...q.keys()].sort()).toEqual(['filename', 'subfolder', 'type'])
  })
})

// `outputs` is comfy's node-id table. Anything else -- an array of node outputs
// included -- names no filename, so `/view` never reaches the container for one
// a caller read out of a malformed history entry.
describe('comfy proxy: a history entry only binds what its node table names', () => {
  test('an outputs that is not a node table binds no filename', async () => {
    const { client, calls } = recordingPromptClient('job-o', (url) => {
      if (url.includes('/history/')) {
        return Response.json({ 'job-o': { outputs: [{ images: [{ filename: 'out.png' }] }] } })
      }
      return new Response('should never be reached')
    })
    const door = await comfyDoor(client)

    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )
    await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-o`))
    const viewed = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=out.png`),
    )

    expect(viewed.status).toBe(404)
    expect(calls.filter((c) => c.url.includes('/view'))).toHaveLength(0)
  })
})

describe('comfy proxy: GET /history is never served bare or for an unknown prompt_id', () => {
  test('an unknown prompt_id is refused without reaching comfy', async () => {
    const { client, calls } = recordingComfyClient(() => new Response('should never be reached'))
    const door = await comfyDoor(client)
    const res = await door.fetch(new Request(`http://engined${PROXY_PATH}/history/never-submitted`))
    expect(res.status).toBe(404)
    expect(calls).toHaveLength(0)
  })
})

describe('comfy proxy: a filename belongs to the prompt that produced it', () => {
  /**
   * `/history` seeds filenames under the ONE prompt it read, never an
   * engine-wide set: an id the caller does own must not turn another
   * prompt's output into a servable filename.
   */
  test('a filename surfaced under prompt A is not viewable by way of prompt B', async () => {
    const { client } = recordingPromptClient('job-a', (url) => {
      if (url.includes('/history/job-a')) {
        return Response.json({
          'job-a': { outputs: { '9': { images: [{ filename: 'a.png' }] } } },
        })
      }
      if (url.includes('/history/job-b')) {
        // comfy's own answer names job-a's output; the door must not adopt it.
        return Response.json({
          'job-a': { outputs: { '9': { images: [{ filename: 'secret.png' }] } } },
        })
      }
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
    })
    const door = await comfyDoor(client)

    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )
    await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-a`))
    await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-b`))

    const own = await door.fetch(new Request(`http://engined${PROXY_PATH}/view?filename=a.png`))
    const other = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=secret.png`),
    )

    expect(own.status).toBe(200)
    expect(other.status).toBe(404)
  })
})

describe('comfy proxy: the binding table outlives the process', () => {
  /** A restart that forgot its bindings would refuse a stored output to the caller that created it. */
  test('a filename bound before a restart is still served after one', async () => {
    const stateHome = mkdtempSync(join(TEST_ROOT, 'state-restart-'))
    const respond = (url: string, init?: RequestInit): Response => {
      if (isQueueRead(url, init)) {
        return idleQueue()
      }
      if (url.includes('/prompt')) {
        return Response.json({ prompt_id: 'job-r' })
      }
      if (url.includes('/history/')) {
        return Response.json({
          'job-r': { outputs: { '9': { images: [{ filename: 'kept.png' }] } } },
        })
      }
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
    }

    const before = await comfyDoor(recordingComfyClient(respond).client, 40_999, stateHome)
    await before.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )
    await before.fetch(new Request(`http://engined${PROXY_PATH}/history/job-r`))

    const after = await comfyDoor(recordingComfyClient(respond).client, 40_999, stateHome)
    const viewed = await after.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=kept.png`),
    )
    const unbound = await after.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=never.png`),
    )

    expect(viewed.status).toBe(200)
    expect(unbound.status).toBe(404)
  })
})

describe('comfy proxy: control verbs never forwarded', () => {
  test('GET /queue bare, POST /free and POST /interrupt all 404 -- release is the only way to drop weights', async () => {
    const { client, calls } = recordingComfyClient(() => new Response('should never be reached'))
    const door = await comfyDoor(client)

    const bareQueue = await door.fetch(new Request(`http://engined${PROXY_PATH}/queue`))
    const free = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/free`, { method: 'POST' }),
    )
    const interrupt = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/interrupt`, { method: 'POST' }),
    )

    expect(bareQueue.status).toBe(404)
    expect(free.status).toBe(404)
    expect(interrupt.status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  test('POST /queue delete is refused for a prompt_id this door never bound, and forwarded for one it did', async () => {
    const { client, calls } = recordingPromptClient('job-3')
    const door = await comfyDoor(client)
    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )

    const foreign = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/queue`, {
        method: 'POST',
        body: JSON.stringify({ delete: ['someone-elses-job'] }),
      }),
    )
    expect(foreign.status).toBe(404)
    // Deletes, not every `/queue` call: submission reads the queue too.
    expect(calls.filter((c) => c.url.includes('/queue') && c.init?.method === 'POST')).toHaveLength(
      0,
    )

    const own = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/queue`, {
        method: 'POST',
        body: JSON.stringify({ delete: ['job-3'] }),
      }),
    )
    expect(own.status).toBe(200)
    expect(calls.filter((c) => c.url.includes('/queue') && c.init?.method === 'POST')).toHaveLength(
      1,
    )
  })
})

/** A minimal stand-in for ComfyUI's own `/ws?clientId=` endpoint: records every clientId a connection dialed in with, and lets the test push frames back down whichever socket is currently open. */
function fakeComfyWsContainer(): {
  port: number
  stop: () => void
  connectedClientIds: string[]
  sendText: (data: unknown) => void
  sendBinary: (bytes: Uint8Array) => void
} {
  const connectedClientIds: string[] = []
  let current: import('bun').ServerWebSocket<{ clientId: string }> | undefined
  const server = Bun.serve<{ clientId: string }>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/ws') {
        const clientId = url.searchParams.get('clientId') ?? ''
        const upgraded = srv.upgrade(req, { data: { clientId } })
        return upgraded ? undefined : new Response('upgrade failed', { status: 400 })
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        connectedClientIds.push(ws.data.clientId)
        current = ws
      },
      message() {
        // Frames only flow comfy -> caller in this suite; nothing the caller sends is asserted on.
      },
      close() {
        current = undefined
      },
    },
  })
  return {
    port: server.port ?? 0,
    stop: () => server.stop(true),
    connectedClientIds,
    sendText: (data) => current?.send(JSON.stringify(data)),
    sendBinary: (bytes) => current?.send(bytes),
  }
}

/** A running comfy engine behind a door bound on a REAL socket -- the one thing a websocket upgrade needs. */
async function startWsDoor(): Promise<{
  fakeComfy: ReturnType<typeof fakeComfyWsContainer>
  doorPort: number
  stop: () => void
}> {
  const fakeComfy = fakeComfyWsContainer()
  const root = mkdtempSync(join(TEST_ROOT, 'door-ws-'))
  writeEngineSpec(root, 'comfy', COMFY_SPEC)
  const doorPort = deadPort()
  // `checkOrigin` refuses any `Host` outside `config.listen_port`, so the
  // config must agree with the port the door is actually bound on.
  const cfg = config({
    listen_port: doorPort,
    engines: [engine({ id: 'comfy', models_dir: '/data/comfy', idle_stop_seconds: 9999 })],
    routes: [route({ engine: 'comfy', model: undefined, upstream: 'local' })],
  })
  const door = createDoor(cfg, {
    enginesRoot: root,
    bunx: BUNX,
    exec: buildExec({ port: fakeComfy.port, containerPort: COMFY_CONTAINER_PORT }),
    probe: () => Promise.resolve({ status: 200 }),
  })
  await door.registry.start('comfy')
  const bound = bindDualFamily(door.fetch, doorPort)
  return {
    fakeComfy,
    doorPort,
    stop: () => {
      bound.v4.stop(true)
      bound.v6.stop(true)
      fakeComfy.stop()
    },
  }
}

/** Resolves with the first frame `pick` accepts, then stops listening. */
function nextFrame<T>(caller: WebSocket, pick: (data: unknown) => T | undefined): Promise<T> {
  return new Promise<T>((resolve) => {
    const onMsg = (ev: MessageEvent) => {
      const picked = pick(ev.data)
      if (picked !== undefined) {
        caller.removeEventListener('message', onMsg)
        resolve(picked)
      }
    }
    caller.addEventListener('message', onMsg)
  })
}

function pickTextFrame(data: unknown): string | undefined {
  return typeof data === 'string' ? data : undefined
}

function pickBinaryFrame(data: unknown): ArrayBuffer | undefined {
  return data instanceof ArrayBuffer ? data : undefined
}

function openCaller(caller: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    caller.onopen = () => resolve()
    caller.onerror = () => reject(new Error('caller socket failed to open'))
  })
}

describe('comfy proxy: the websocket bridge', () => {
  test('the door assigns its own clientId, announces it first, and bridges text and binary frames', async () => {
    const { fakeComfy, doorPort, stop } = await startWsDoor()
    try {
      const caller = new WebSocket(
        `ws://127.0.0.1:${doorPort}${PROXY_PATH}/ws?clientId=caller-picked-this`,
      )
      caller.binaryType = 'arraybuffer'
      // Listen before the socket opens: the announcement is the first frame down.
      const firstFrame = nextFrame(caller, pickTextFrame)
      await openCaller(caller)

      const announced = JSON.parse(await firstFrame) as {
        type: string
        data: { client_id: string }
      }
      expect(announced.type).toBe('client_id')
      // The door minted its own id -- never the one the caller asked for in
      // the query string, which is exactly the eavesdrop this exists to close.
      expect(announced.data.client_id).not.toBe('caller-picked-this')
      // ...and it is the SAME id the door itself dialed comfy's real /ws with.
      expect(fakeComfy.connectedClientIds).toEqual([announced.data.client_id])

      const progressText = nextFrame(caller, pickTextFrame)
      fakeComfy.sendText({ type: 'progress', data: { value: 3, max: 10 } })
      expect(JSON.parse(await progressText)).toEqual({
        type: 'progress',
        data: { value: 3, max: 10 },
      })

      const binaryFrame = nextFrame(caller, pickBinaryFrame)
      const preview = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9])
      fakeComfy.sendBinary(preview)
      expect(new Uint8Array(await binaryFrame)).toEqual(preview)

      caller.close()
    } finally {
      stop()
    }
  })
})

type Door = Awaited<ReturnType<typeof comfyDoor>>

function cancellingComfyClient(
  running: string[],
  pending: string[],
  deleteStatus = 200,
  interruptStatus = 200,
) {
  let submitted = false
  return recordingComfyClient((url, init) => {
    if (url.includes('/prompt')) {
      submitted = true
      return Response.json({ prompt_id: 'job-c' })
    }
    if (url.includes('/interrupt')) {
      return Response.json({}, { status: interruptStatus })
    }
    if (isQueueRead(url, init)) {
      // The container holds nothing until the door's own submission lands:
      // a submission reads the queue before it forwards, and a fake that
      // reported the job already queued would be describing a state this
      // door cannot produce.
      return submitted
        ? Response.json({
            queue_running: running.map((id) => [0, id]),
            queue_pending: pending.map((id) => [0, id]),
          })
        : idleQueue()
    }
    return Response.json({}, { status: deleteStatus })
  })
}

async function boundDoor(client: HttpClient) {
  const door = await comfyDoor(client)
  await door.fetch(
    new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
  )
  return door
}

function cancel(door: Door, promptId: string) {
  return door.fetch(
    new Request(`http://engined${PROXY_PATH}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ prompt_id: promptId }),
    }),
  )
}

// The door refuses a bare `/interrupt` because comfy carries no id to scope
// it. `/cancel` is what makes one safe: the door reads the queue itself and
// only interrupts once the running prompt is provably the caller's own.
describe('comfy proxy: a scoped cancel the door can prove and perform', () => {
  test("POST /cancel interrupts the container only when the caller's own prompt is the running one", async () => {
    const { client, calls } = cancellingComfyClient(['job-c'], [])
    const res = await cancel(await boundDoor(client), 'job-c')

    expect(res.status).toBe(200)
    await expectJobCCancelled(res, 'running', calls, 1)
  })

  test('POST /cancel drops a not-yet-started prompt from the queue instead of interrupting', async () => {
    const { client, calls } = cancellingComfyClient(['someone-elses-job'], ['job-c'])
    const res = await cancel(await boundDoor(client), 'job-c')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ prompt_id: 'job-c', cancelled: 'pending' })
    expect(calls.filter((c) => c.url.includes('/interrupt'))).toHaveLength(0)
    const deletes = calls.filter((c) => c.url.includes('/queue') && c.init?.method === 'POST')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]?.init?.body).toBe(JSON.stringify({ delete: ['job-c'] }))
  })

  // A cancel that lands after the render finished must not interrupt whatever
  // inherited the GPU behind it.
  test('POST /cancel reports a finished prompt without touching the container', async () => {
    const { client, calls } = cancellingComfyClient(['a-later-job'], [])
    const res = await cancel(await boundDoor(client), 'job-c')

    expect(await res.json()).toEqual({ prompt_id: 'job-c', cancelled: 'finished' })
    expect(calls.filter((c) => c.url.includes('/interrupt'))).toHaveLength(0)
  })
})

describe('comfy proxy: a scoped cancel the door refuses', () => {
  // Reporting a cancel comfy never performed is worse than reporting none:
  // the caller stops waiting for a prompt that is still queued to render.
  test('POST /cancel reports a queue delete comfy refused, never a cancel it did not perform', async () => {
    const { client } = cancellingComfyClient(['someone-elses-job'], ['job-c'], 500)
    await refusedCancel(await cancel(await boundDoor(client), 'job-c'))
  })

  // The running branch is the one holding the GPU: a caller told the render was
  // interrupted stops polling, and a refused interrupt leaves it rendering to
  // completion with nobody waiting on it.
  test('POST /cancel reports an interrupt comfy refused, never a cancel it did not perform', async () => {
    const { client, calls } = cancellingComfyClient(['job-c'], [], 200, 500)
    const res = await cancel(await boundDoor(client), 'job-c')
    await refusedCancel(res)
    expect(calls.filter((c) => c.url.includes('/interrupt'))).toHaveLength(1)
  })

  // Whatever comfy answered, it was not a queue: the door cannot prove the
  // prompt is the caller's own, so it interrupts nothing and says so.
  test("POST /cancel refuses when comfy's queue does not read as one", async () => {
    let submitted = false
    const { client, calls } = recordingComfyClient((url) => {
      if (url.includes('/prompt')) {
        submitted = true
        return Response.json({ prompt_id: 'job-c' })
      }
      // Readable for the submission's own drain check, then not: it is the
      // cancel's queue read that has to find something that is not a queue.
      return submitted
        ? new Response('null', { headers: { 'content-type': 'application/json' } })
        : idleQueue()
    })
    const res = await cancel(await boundDoor(client), 'job-c')

    expect(res.status).toBe(502)
    expect(calls.filter((c) => c.url.includes('/interrupt'))).toHaveLength(0)
  })

  test('POST /cancel never interrupts on behalf of a prompt_id this door did not bind', async () => {
    const { client, calls } = cancellingComfyClient(['someone-elses-job'], [])
    const res = await cancel(await boundDoor(client), 'someone-elses-job')

    expect(res.status).toBe(404)
    expect(calls.filter((c) => c.url.includes('/interrupt'))).toHaveLength(0)
  })
})

// comfy's `/interrupt` stops whatever is running and carries no id to scope
// it, so a cancel is only safe when nothing can inherit the GPU behind the
// prompt being cancelled. Holding submissions is what makes that true.
describe('comfy proxy: an aborted caller never reaches POST /prompt', () => {
  test('an aborted caller results in no POST', async () => {
    const { client, calls } = recordingComfyClient(() => new Response('should never be reached'))
    const door = await comfyDoor(client)
    const ac = new AbortController()
    ac.abort()
    const res = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, {
        method: 'POST',
        body: '{}',
        signal: ac.signal,
      }),
    )
    expect(res.status).toBe(499)
    expect(await res.json()).toEqual(
      jsonErrorBody(STATUS_CLIENT_CLOSED, 'the caller hung up before the prompt was submitted'),
    )
    expect(calls.filter((c) => c.url.includes('/prompt'))).toHaveLength(0)
  })

  test('a prompt that was POSTed is not reported as unsubmitted when the caller then hangs up', async () => {
    const ac = new AbortController()
    const { client, calls } = recordingComfyClient((url, init) => {
      if (isQueueRead(url, init)) {
        return idleQueue()
      }
      if (url.includes('/prompt')) {
        ac.abort()
        return Response.json({ prompt_id: 'job-1', number: 1 })
      }
      return idleQueue()
    })
    const door = await comfyDoor(client)
    const res = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, {
        method: 'POST',
        body: '{}',
        signal: ac.signal,
      }),
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { prompt_id: string }).prompt_id).toBe('job-1')
    expect(calls.filter((c) => c.url.includes('/prompt'))).toHaveLength(1)
  })
})

describe('comfy proxy: one prompt in the container at a time', () => {
  /** A fake whose queue the test drives: `holding` is what the container reports until the test empties it. */
  function gatedComfyClient(holding: string[]) {
    return recordingComfyClient((url, init) => {
      if (url.includes('/prompt')) {
        return Response.json({ prompt_id: `job-${holding.length}` })
      }
      if (isQueueRead(url, init)) {
        return Response.json({
          queue_running: holding.map((id) => [0, id]),
          queue_pending: [],
        })
      }
      return Response.json({})
    })
  }

  test('a submission is not forwarded while the container is still rendering, and lands once it drains', async () => {
    const holding: string[] = []
    const { client, calls } = gatedComfyClient(holding)
    const door = await comfyDoor(client)
    const submit = () =>
      door.fetch(new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }))

    const first = await submit()
    expect(first.status).toBe(200)
    // The container now holds it, exactly as it would after a real submission.
    holding.push('job-0')

    const second = submit()
    // Long enough to cover several drain polls: if the gate did not hold, the
    // second prompt would already be sitting in the container beside the first.
    await Bun.sleep(300)
    expect(calls.filter((c) => c.url.includes('/prompt'))).toHaveLength(1)

    holding.length = 0
    expect((await second).status).toBe(200)
    expect(calls.filter((c) => c.url.includes('/prompt'))).toHaveLength(2)
  })

  /**
   * The ceiling that stops a wedged container parking every later submission
   * on this door forever. Driven from config so this proves it in a second
   * rather than the fifteen minutes the default would take -- which is the
   * whole reason the default is a key and not a constant.
   */
  test('a container that never frees refuses the submission, naming the key that would allow it', async () => {
    // Never drains: the queue always reports something running.
    const { client, calls } = gatedComfyClient(['someone-elses-job'])
    const door = await comfyDoor(client, 40_999, undefined, { drain_timeout_seconds: 1 })

    const started = Date.now()
    const res = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )
    const body = (await res.json()) as { error?: string }

    expect(res.status).toBe(503)
    expect(errorMessageOf(body)).toContain('drain_timeout_seconds')
    expect(errorMessageOf(body)).toContain('1s')
    // It waited rather than refusing on the first look, and it did not wait
    // the fifteen-minute default.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000)
    expect(Date.now() - started).toBeLessThan(10_000)
    // Nothing was ever handed to the container.
    expect(calls.filter((c) => c.url.includes('/prompt'))).toHaveLength(0)
  })

  /**
   * The budget bounds how long a busy container is waited on, never whether
   * the container is asked at all: the submit is attempted before the
   * deadline is ever consulted, so an idle container answers on the first
   * pass however small the budget is.
   */
  test('the smallest budget still buys one submission against an idle container', async () => {
    const { client, calls } = gatedComfyClient([])
    const door = await comfyDoor(client, 40_999, undefined, { drain_timeout_seconds: 0.001 })

    const res = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )

    expect(res.status).toBe(200)
    expect(calls.filter((c) => c.url.includes('/prompt'))).toHaveLength(1)
  })

  /** Zero is the one number that reads as "no ceiling" and would mean the opposite, so config load refuses it rather than serving a wait nobody asked for. */
  test('drain_timeout_seconds = 0 is refused at config load, naming the key', () => {
    const path = join(mkdtempSync(join(TEST_ROOT, 'drain-config-')), 'config.toml')
    writeFileSync(path, '[[engine]]\nid = "comfy"\ndrain_timeout_seconds = 0\n')

    expect(() => loadConfig(path)).toThrow(RX_DRAIN_TIMEOUT_POSITIVE)
  })

  /**
   * The race the gate exists to close. A cancel confirms the caller's prompt
   * is running and then sends an unscoped interrupt; the interrupt is only
   * safe because nothing else can be queued to inherit the GPU when that
   * prompt ends. A submission arriving in that window must wait, not queue.
   */
  test("a submission cannot enter the container between a cancel's queue read and its interrupt", async () => {
    const holding: string[] = []
    const { client, calls } = gatedComfyClient(holding)
    const door = await comfyDoor(client)
    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )
    holding.push('job-0')

    const queued = door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )
    const cancelled = await cancel(door, 'job-0')
    expect(await cancelled.json()).toEqual({ prompt_id: 'job-0', cancelled: 'running' })

    const order = calls.map((c) => c.url)
    const interrupt = order.findIndex((u) => u.includes('/interrupt'))
    const secondPrompt = order.filter((u) => u.includes('/prompt')).length
    expect(interrupt).toBeGreaterThanOrEqual(0)
    // Nothing was forwarded to `/prompt` a second time before the interrupt,
    // so there was no successor in the container to inherit the GPU.
    expect(secondPrompt).toBe(1)

    holding.length = 0
    expect((await queued).status).toBe(200)
  })
})

// comfy answers 200 to a queue delete that removed nothing, so the status of
// the delete cannot decide what the caller is told.
describe('comfy proxy: a cancel reports what the container did, not what was asked', () => {
  test('a pending prompt that started rendering during the delete is interrupted, not reported dropped', async () => {
    const { client, calls } = jobCDuringDeleteClient((reads) => {
      // 1: the submission's own drain check. 2: the cancel finds it pending.
      // 3: after the delete, it has started rendering -- the window this
      // second read exists to see.
      if (reads === 1) {
        return idleQueue()
      }
      return reads === 2
        ? Response.json({ queue_running: [], queue_pending: [[0, 'job-c']] })
        : Response.json({ queue_running: [[0, 'job-c']], queue_pending: [] })
    }, true)
    const res = await cancel(await boundDoor(client), 'job-c')
    await expectJobCCancelled(res, 'running', calls, 1)
  })

  test('a pending prompt the delete really removed is still reported pending', async () => {
    const { client, calls } = jobCDuringDeleteClient(
      (reads) =>
        reads === 2
          ? Response.json({ queue_running: [], queue_pending: [[0, 'job-c']] })
          : idleQueue(),
      false,
    )
    const res = await cancel(await boundDoor(client), 'job-c')
    await expectJobCCancelled(res, 'pending', calls, 0)
  })
})

describe('comfy proxy: the binding table is bounded', () => {
  /**
   * The whole table is rewritten on every bind, so an unbounded one costs
   * more per prompt forever. The bound is only safe if it drops the oldest
   * binding -- evicting the newest would refuse the output of the prompt the
   * caller is still waiting on -- and if disk agrees with memory, since a
   * restart reads disk back as the whole truth.
   */
  test('past its bound the table holds 1000 and the oldest binding is the one gone, in memory and on disk', async () => {
    const stateHome = mkdtempSync(join(TEST_ROOT, 'state-bound-'))
    let issued = 0
    const respond = (url: string): Response => {
      if (!url.includes('/prompt')) {
        return Response.json({})
      }
      issued += 1
      return Response.json({ prompt_id: `job-${issued}` })
    }

    const door = await comfyDoor(recordingComfyClient(respond).client, 40_999, stateHome)
    for (let i = 0; i < 1001; i++) {
      await door.fetch(
        new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
      )
    }

    const onDisk = JSON.parse(readFileSync(comfyBindingsPath(), 'utf8')) as Record<string, unknown>
    expect(Object.keys(onDisk)).toHaveLength(1000)

    // In memory: the first prompt bound is the one the door no longer knows,
    // and the one bound right after it survives.
    const evicted = await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-1`))
    const oldestKept = await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-2`))
    const newest = await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-1001`))
    expect(evicted.status).toBe(404)
    expect(oldestKept.status).toBe(200)
    expect(newest.status).toBe(200)

    // ...and a restart reading that file back answers identically.
    const restarted = await comfyDoor(recordingComfyClient(respond).client, 40_999, stateHome)
    expect(
      (await restarted.fetch(new Request(`http://engined${PROXY_PATH}/history/job-1`))).status,
    ).toBe(404)
    expect(
      (await restarted.fetch(new Request(`http://engined${PROXY_PATH}/history/job-2`))).status,
    ).toBe(200)
    expect(
      (await restarted.fetch(new Request(`http://engined${PROXY_PATH}/history/job-1001`))).status,
    ).toBe(200)
  })
})

describe('comfy proxy: a binding the state dir would not take', () => {
  /**
   * The table in memory is a superset of the file, never the other way
   * round: a write that fails costs the caller nothing until this process
   * restarts, where a table shrunk to match a file that never got the
   * binding would refuse an output the door itself produced.
   */
  test('a binding that could not be persisted is still served, and the file never gained it', async () => {
    const stateHome = mkdtempSync(join(TEST_ROOT, 'state-readonly-'))
    const engined = join(stateHome, 'engined')
    mkdirSync(engined, { mode: 0o500 })
    const { client } = recordingComfyClient((url) =>
      url.includes('/prompt') ? Response.json({ prompt_id: 'job-w' }) : Response.json({}),
    )

    const door = await comfyDoor(client, 40_999, stateHome)
    const bound = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )
    const served = await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-w`))

    expect(bound.status).toBe(200)
    expect(served.status).toBe(200)
    expect(existsSync(comfyBindingsPath())).toBe(false)
    chmodSync(engined, 0o700)
  })
})

describe('comfy proxy: the table is written only when it changed', () => {
  // A client watching a running prompt polls the same entry until it
  // finishes, and every one of those reads answers with what the door
  // already knows.
  test('polling /history for filenames the door already holds does not rewrite the table', async () => {
    const stateHome = mkdtempSync(join(TEST_ROOT, 'state-poll-'))
    const { client } = recordingComfyClient((url) =>
      url.includes('/prompt')
        ? Response.json({ prompt_id: 'job-p' })
        : Response.json({ 'job-p': { outputs: { '9': { images: [{ filename: 'out.png' }] } } } }),
    )

    const door = await comfyDoor(client, 40_999, stateHome)
    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )
    await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-p`))

    const file = comfyBindingsPath()
    rmSync(file)
    const repoll = await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-p`))

    expect(repoll.status).toBe(200)
    expect(existsSync(file)).toBe(false)
  })
})

// The count bound is a bound on the TABLE, so a quiet week leaves a binding
// servable and a busy hour expires one minutes old. Neither is something a
// consumer holding filenames can plan around; an age is.
describe('comfy proxy: a binding ages out', () => {
  const DayMs = 24 * 60 * 60 * 1000
  /** `comfyKey`'s own separator: engine, origin, prompt id, NUL between each. */
  const KeyPrefix = 'comfy\u0000local\u0000'

  /** Writes the binding table directly, so a test can plant an age without waiting for one. */
  function plantBindings(
    stateHome: string,
    table: Record<
      string,
      { at: number; views: { filename: string; subfolder: string; type: string }[] }
    >,
  ) {
    process.env.XDG_STATE_HOME = stateHome
    mkdirSync(dirname(comfyBindingsPath()), { recursive: true })
    writeFileSync(comfyBindingsPath(), JSON.stringify(table))
  }

  test('a binding older than the ttl is refused, and a recent one beside it is still served', async () => {
    const stateHome = mkdtempSync(join(TEST_ROOT, 'state-ttl-'))
    plantBindings(stateHome, {
      [`${KeyPrefix}job-old`]: {
        at: Date.now() - 8 * DayMs,
        views: [{ filename: 'old.png', subfolder: '', type: 'output' }],
      },
      [`${KeyPrefix}job-new`]: {
        at: Date.now() - DayMs,
        views: [{ filename: 'new.png', subfolder: '', type: 'output' }],
      },
    })
    const { client } = recordingComfyClient((url, init) => {
      if (isQueueRead(url, init)) {
        return idleQueue()
      }
      if (url.includes('/history/')) {
        return Response.json({})
      }
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
    })
    const door = await comfyDoor(client, 40_999, stateHome)

    // Both halves of the mediation honour the age, not just one: /history keys
    // on the binding itself and /view scans the filenames under it.
    const oldHistory = await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-old`))
    const newHistory = await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-new`))
    const oldView = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=old.png`),
    )
    const newView = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=new.png`),
    )

    expect(oldHistory.status).toBe(404)
    expect(newHistory.status).toBe(200)
    expect(oldView.status).toBe(404)
    expect(newView.status).toBe(200)
  })

  test('the next save drops what aged out, so the file does not keep it forever', async () => {
    const stateHome = mkdtempSync(join(TEST_ROOT, 'state-ttl-save-'))
    plantBindings(stateHome, {
      [`${KeyPrefix}job-old`]: {
        at: Date.now() - 8 * DayMs,
        views: [{ filename: 'old.png', subfolder: '', type: 'output' }],
      },
    })
    const { client } = recordingComfyClient((url, init) => {
      if (isQueueRead(url, init)) {
        return idleQueue()
      }
      return Response.json({ prompt_id: 'job-fresh' })
    })
    const door = await comfyDoor(client, 40_999, stateHome)

    // Any bind saves the table, which is when the aged entry goes.
    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: 'POST', body: '{}' }),
    )

    const onDisk = JSON.parse(readFileSync(comfyBindingsPath(), 'utf8')) as Record<string, unknown>
    expect(Object.keys(onDisk)).toEqual([`${KeyPrefix}job-fresh`])
  })
})

describe('loading the binding table', () => {
  /** A scratch state home holding `body` as its binding table, or holding no table at all. */
  function stateWith(body?: string): void {
    const home = mkdtempSync(join(TEST_ROOT, 'load-'))
    process.env.XDG_STATE_HOME = home
    if (body !== undefined) {
      mkdirSync(dirname(comfyBindingsPath()), { recursive: true })
      writeFileSync(comfyBindingsPath(), body)
    }
  }

  test('entries this build cannot read are counted, not dropped in silence', () => {
    stateWith(
      JSON.stringify({
        'comfy local old-a': [],
        'comfy local old-b': [],
        'comfy local current': {
          at: Date.now(),
          views: [{ filename: 'a.png', subfolder: '', type: 'output' }],
        },
      }),
    )
    const { lines, write } = collectLines()
    const table = loadComfyBindings(write)
    expect(table.size).toBe(1)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toEqual({
      comfy_bindings: 'partial',
      dropped: 2,
      kept: 1,
    })
  })

  test('the line carries counts only: a key is the prompt id that produced it', () => {
    stateWith(JSON.stringify({ 'comfy local job-2f9c': [] }))
    const { lines, write } = collectLines()
    loadComfyBindings(write)
    expect(lines[0]).not.toContain('job-2f9c')
  })

  test('a table voided whole is told apart from a first start', () => {
    stateWith('{ not json at all')
    const { lines, write } = collectLines()
    expect(loadComfyBindings(write).size).toBe(0)
    expect(JSON.parse(lines[0] as string)).toEqual({
      comfy_bindings: 'unreadable',
      dropped: 'all',
      kept: 0,
    })

    stateWith()
    const { lines: absent, write: writeAbsent } = collectLines()
    expect(loadComfyBindings(writeAbsent).size).toBe(0)
    expect(absent).toEqual([])
  })

  test('a table this build can read in full writes nothing', () => {
    stateWith(JSON.stringify({ 'comfy local j': { at: Date.now(), views: [] } }))
    const { lines, write } = collectLines()
    expect(loadComfyBindings(write).size).toBe(1)
    expect(lines).toEqual([])
  })
})
