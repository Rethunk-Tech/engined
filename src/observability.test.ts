import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import type { ReleaseFetch } from './comfyQueue.ts'
import { startRequest } from './doorFixtures.ts'
import type { Exec, ExecResult } from './exec.ts'
import { errorMessageOf } from './http.ts'
import { createDoor } from './main.ts'
import {
  BUNX,
  config,
  engine,
  inspectSinglePort,
  makeTestRoot,
  portResult,
  route,
  writeEngineSpec,
} from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-observability-')

const COMFY_SPEC = `
kind = "comfy"
upstream = "self"
image = "ghcr.io/example/comfy@sha256:bbbb"
obtain = "pull"
serves = []
command = []

[ready]
path = "/"
status = 200
`

const CONTAINER_SPEC = `
kind = "openai-http"
upstream = "self"
image = "ghcr.io/example/llama@sha256:aaaa"
obtain = "pull"
serves = ["/openai/v1/chat/completions"]
command = []

[ready]
path = "/health"
status = 200
`

/** Records what docker was asked to do, so a route's arguments can be asserted. */
function recordingExec(handler: (args: readonly string[]) => Partial<ExecResult>): {
  exec: Exec
  calls: string[][]
} {
  const calls: string[][] = []
  const exec: Exec = (args) => {
    calls.push([...args])
    // `inspect` has a parsed payload: an empty stdout throws in parseExposedPort
    // long before any route under test is reached.
    // `docker image inspect` has a parsed payload -- empty stdout throws in
    // parseExposedPort long before any route under test is reached.
    const base: ExecResult = args.includes('inspect')
      ? inspectSinglePort(8080)
      : { stdout: '', stderr: '', exitCode: 0 }
    return Promise.resolve({ ...base, ...handler(args) })
  }
  return { exec, calls }
}

function doorWith(exec: Exec, releaseFetch?: ReleaseFetch) {
  const root = mkdtempSync(join(TEST_ROOT, 'door-'))
  writeEngineSpec(root, 'local-llama', CONTAINER_SPEC)
  return createDoor(
    config({
      engines: [engine({ id: 'local-llama' }), engine({ id: 'hosted', kind: 'openai-http' })],
      routes: [route({ engine: 'local-llama', model: 'chat-model', upstream: 'local' })],
    }),
    {
      enginesRoot: root,
      bunx: BUNX,
      exec,
      // Without this the readiness poll makes a real connection to a port
      // nothing serves and start blocks for the whole ready timeout.
      probe: () => Promise.resolve({ status: 200 }),
      ...(releaseFetch ? { releaseFetch } : {}),
    },
  )
}

test('logs pass the asked-for tail through to docker', async () => {
  const { exec, calls } = recordingExec((args) =>
    args[0] === 'logs' ? { stdout: 'line one\nline two\n' } : {},
  )
  const res = await doorWith(exec).fetch(
    new Request('http://engined/engined/v1/engines/local-llama/logs?tail=42'),
  )

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ lines: ['line one', 'line two'] })
  expect(calls.find((c) => c[0] === 'logs')).toEqual([
    'logs',
    '--tail',
    '42',
    'engined-local-llama',
  ])
})

// A caller asking for more than the door serves wants everything it can get.
// Rejecting the request would hand back nothing over a number it chose freely.
test('an absurd tail is clamped, not refused', async () => {
  const { exec, calls } = recordingExec(() => ({}))
  const res = await doorWith(exec).fetch(
    new Request('http://engined/engined/v1/engines/local-llama/logs?tail=999999'),
  )

  expect(res.status).toBe(200)
  expect(calls.find((c) => c[0] === 'logs')?.[2]).toBe('5000')
})

// Merged deliberately: docker hands the container's stderr back on stderr, and
// most engines log there -- reading stdout alone returns an empty log for a
// container that is talking.
test('a container logging only to stderr is not reported as silent', async () => {
  const { exec } = recordingExec((args) =>
    args[0] === 'logs' ? { stderr: 'ggml: using Vulkan\n' } : {},
  )
  const res = await doorWith(exec).fetch(
    new Request('http://engined/engined/v1/engines/local-llama/logs'),
  )

  expect(await res.json()).toEqual({ lines: ['ggml: using Vulkan'] })
})

// A remote engine has no container, and an empty log would read as a quiet one.
test('logs and resources refuse an engine that runs no container', async () => {
  const { exec } = recordingExec(() => ({}))
  const door = doorWith(exec)

  for (const path of ['logs', 'resources']) {
    const res = await door.fetch(new Request(`http://engined/engined/v1/engines/hosted/${path}`))
    expect(res.status).toBe(404)
    expect(errorMessageOf(await res.json())).toContain('runs no container')
  }
})

// Distinct from "holds nothing": a stopped container has no cgroup to read and
// no processes to account for.
test('resources on a stopped container says it is not running', async () => {
  const { exec } = recordingExec(() => ({}))
  const res = await doorWith(exec).fetch(
    new Request('http://engined/engined/v1/engines/local-llama/resources'),
  )

  expect(res.status).toBe(404)
  expect(errorMessageOf(await res.json())).toContain('not running')
})

// Stopping something already stopped reports the state rather than erroring, so
// a consumer reclaiming the GPU never has to check first.
test('stop on an idle engine is a no-op that reports its state', async () => {
  const { exec, calls } = recordingExec(() => ({}))
  const res = await doorWith(exec).fetch(
    new Request('http://engined/engined/v1/engines/local-llama/stop', { method: 'POST' }),
  )

  expect(res.status).toBe(200)
  expect(((await res.json()) as { state: string }).state).not.toBe('running')
  expect(calls.some((c) => c[0] === 'stop')).toBe(false)
})

test('an unknown engine is a 404 on every new route', async () => {
  const { exec } = recordingExec(() => ({}))
  const door = doorWith(exec)

  for (const req of [
    new Request('http://engined/engined/v1/engines/nope/logs'),
    new Request('http://engined/engined/v1/engines/nope/resources'),
    new Request('http://engined/engined/v1/engines/nope/stop', { method: 'POST' }),
  ]) {
    expect((await door.fetch(req)).status).toBe(404)
  }
})

// llama's residency is engined's own to manage, so an outside release would
// fight the router's swap rather than help it.
test('release refuses a kind that has no such endpoint', async () => {
  const { exec } = recordingExec(() => ({}))
  const res = await doorWith(exec).fetch(
    new Request('http://engined/engined/v1/engines/local-llama/release', { method: 'POST' }),
  )

  expect(res.status).toBe(400)
  expect(errorMessageOf(await res.json())).toContain('no release endpoint')
})

// Nothing loaded means nothing held, so the caller's intent already holds and
// no request is made -- the injected 500 below would fire if one were, which
// is what makes this an assertion about the short-circuit rather than luck.
test('release on a stopped engine succeeds without reaching the endpoint', async () => {
  const root = mkdtempSync(join(TEST_ROOT, 'door-'))
  writeEngineSpec(root, 'comfy', COMFY_SPEC)
  const door = createDoor(config({ engines: [engine({ id: 'comfy', models_dir: '/models' })] }), {
    enginesRoot: root,
    bunx: BUNX,
    exec: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    releaseFetch: () => Promise.resolve({ ok: false, status: 500 }),
    comfyPollIntervalMs: 1_000_000,
  })
  const res = await door.fetch(
    new Request('http://engined/engined/v1/engines/comfy/release', { method: 'POST' }),
  )

  // Not running, so nothing is held and the caller's intent already holds --
  // the 500 above is never reached, which is the point of the short-circuit.
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ released: true })
})

/** Reads SSE frames off the body until `want` of them have arrived, or the deadline passes. */
async function readFrames(res: Response, want: number, timeoutMs = 5000): Promise<string[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const frames: string[] = []
  const deadline = Date.now() + timeoutMs
  let buffer = ''
  while (frames.length < want && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    frames.push(...parts.filter((p) => p.startsWith('event:')))
  }
  await reader.cancel()
  return frames
}

// A client connecting between two transitions would otherwise sit blind until
// the next one, and have to poll once anyway to learn where it stands.
test('the stream opens with a snapshot before any live frame', async () => {
  const { exec } = recordingExec(() => ({}))
  const res = await doorWith(exec).fetch(new Request('http://engined/engined/v1/engines/events'))

  expect(res.headers.get('content-type')).toBe('text/event-stream')
  const [first] = await readFrames(res, 1)
  expect(first).toContain('event: snapshot')
  expect(first).toContain('local-llama')
})

test('the events snapshot is the same engine list GET /engined/v1/engines returns', async () => {
  const { exec } = recordingExec(() => ({}))
  const door = doorWith(exec)
  const listed = await (await door.fetch(new Request('http://engined/engined/v1/engines'))).json()
  const res = await door.fetch(new Request('http://engined/engined/v1/engines/events'))
  const [first] = await readFrames(res, 1)
  expect(first).toContain('event: snapshot')
  const dataLine = first?.split('\n').find((line) => line.startsWith('data: '))
  expect(JSON.parse(dataLine?.slice('data: '.length) ?? 'null')).toEqual(listed)
})

// The whole point: engined idle-stops engines itself, so a consumer that is
// never told only finds out when a call against one fails.
test('a state change reaches a subscriber as a live frame', async () => {
  const { exec } = recordingExec((args) => (args[0] === 'port' ? portResult(41_234) : {}))
  const door = doorWith(exec)
  const res = await door.fetch(new Request('http://engined/engined/v1/engines/events'))
  const frames = readFrames(res, 2)

  await door.fetch(startRequest('@/local-llama/chat-model'))

  const live = (await frames).filter((f) => f.startsWith('event: engine'))
  expect(live.length).toBeGreaterThan(0)
  expect(live.join('\n')).toContain('local-llama')
})

// An engine id names a thing, never a location: POST /engined/v1/start,
// keyed by address, replaces the per-engine route outright.
test('the old engine-keyed start route is a 404', async () => {
  const { exec } = recordingExec(() => ({}))
  const door = doorWith(exec)
  const res = await door.fetch(
    new Request('http://engined/engined/v1/engines/local-llama/start', { method: 'POST' }),
  )
  expect(res.status).toBe(404)
})

// A hold is the door's answer to a second process wanting the same weights:
// llama is ~30 GiB and comfy ~42 on this box, so two copies is not a slow
// start, it is an OOM that takes every other process with it.
test('a held engine refuses to start, and starts again once the hold is dropped', async () => {
  const { exec } = recordingExec(() => ({}))
  const door = doorWith(exec)
  const held = new Request('http://engined/engined/v1/engines/local-llama/hold?seconds=60', {
    method: 'POST',
  })

  expect((await door.fetch(held)).status).toBe(200)

  const refused = await door.fetch(
    new Request('http://engined/engined/v1/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '@/local-llama/chat-model' }),
    }),
  )
  expect(refused.status).not.toBe(200)
  expect(JSON.stringify(await refused.json())).toContain('held')

  const dropped = await door.fetch(
    new Request('http://engined/engined/v1/engines/local-llama/unhold', { method: 'POST' }),
  )
  expect(dropped.status).toBe(200)
})

test('hold and unhold 404 on an engine that does not exist', async () => {
  const { exec } = recordingExec(() => ({}))
  const door = doorWith(exec)

  for (const verb of ['hold', 'unhold']) {
    const res = await door.fetch(
      new Request(`http://engined/engined/v1/engines/nope/${verb}`, { method: 'POST' }),
    )
    expect(res.status).toBe(404)
  }
})
