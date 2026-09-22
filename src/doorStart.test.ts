import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { DockerLifecycle } from './docker.ts'
import { createLlamaDoor, llamaDoorConfig, READY_200, startRequest } from './doorFixtures.ts'
import type { HttpClient } from './http.ts'
import { createDoor } from './main.ts'
import {
  BUNX,
  buildExec,
  config,
  engine,
  llamaControlPlane,
  makeTestRoot,
  route,
  tempPresetPath,
  writeEngineSpec,
} from './test-support.ts'
import type { Config } from './types.ts'

const TEST_ROOT = makeTestRoot('engined-door-start-test-')

/** Mirrors engines/whisper's real shape: a real "-m <path>" pair for `withModelFile` to rewrite. */
const STT_SPEC = `
kind = "stt"
upstream = "self"
image = "engined/fakestt:local"
obtain = "build"
serves = ["/openai/v1/audio/transcriptions"]
command = ["--host", "0.0.0.0", "-m", "/models/default.bin"]

[ready]
path = "/health"
status = 200
`

/** Every URL the llama router's own HTTP client was asked to hit, alongside the real load/unload/models control-plane replies -- `urls` is what proves a warm actually reached llama-server rather than merely returning without error. */
function makeRecordingLlamaClient(): { client: HttpClient; urls: string[] } {
  const control = llamaControlPlane()
  const urls: string[] = []
  const client: HttpClient = (url, init) => {
    urls.push(url)
    const controlled = control(url, init)
    if (controlled) {
      return Promise.resolve(controlled)
    }
    return Promise.resolve(
      Response.json({ id: 'resp-1', choices: [{ message: { content: 'hi' } }] }),
    )
  }
  return { client, urls }
}

const WHISPER_SMALL_ROUTE = route({
  engine: 'whisper-like',
  upstream: 'local',
  model: 'small',
  filename: 'small.bin',
})

/** A fresh engines root carrying whisper's spec, and a config with its `small` route plus `extraRoutes`. */
function whisperDoorConfig(...extraRoutes: ReturnType<typeof route>[]): {
  cfg: Config
  root: string
} {
  const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
  writeEngineSpec(root, 'whisper-like', STT_SPEC)
  const cfg = config({
    engines: [engine({ id: 'whisper-like', models_dir: '/data/whisper' })],
    routes: [WHISPER_SMALL_ROUTE, ...extraRoutes],
  })
  return { cfg, root }
}

/** llama and whisper side by side, chained llama-first, so a start on the chain has a second hop it must NOT warm. */
function llamaThenWhisperChainConfig(): { cfg: Config; root: string } {
  const { root } = llamaDoorConfig(TEST_ROOT)
  writeEngineSpec(root, 'whisper-like', STT_SPEC)
  const cfg = config({
    engines: [
      engine({ id: 'local-llama', models_dir: '/data/gguf', models_max: 1 }),
      engine({ id: 'whisper-like', models_dir: '/data/whisper' }),
    ],
    routes: [
      route({ engine: 'local-llama', model: 'ornith', filename: 'x.gguf', role: 'chat' }),
      WHISPER_SMALL_ROUTE,
    ],
    chains: { 'chain-x': ['@/local-llama/ornith', '@/whisper-like/small'] },
  })
  return { cfg, root }
}

/**
 * `started` names the call that actually launched the engine, not merely
 * whether it ends up running: the second call against an already-warm route
 * finds `state: "running"` too, but must report `started: false` so a caller
 * can stop polling `/openai/v1/models` to tell a cold start from a warm one.
 */
async function startedFlagsAcrossTwoCalls(): Promise<{
  firstState: unknown
  firstStarted: unknown
  secondState: unknown
  secondStarted: unknown
}> {
  const { cfg, root } = llamaDoorConfig(TEST_ROOT)
  const { client } = makeRecordingLlamaClient()
  const door = createLlamaDoor(cfg, root, { llamaHttpClient: client })

  const first = await door.fetch(startRequest('@/local-llama/ornith'))
  const firstBody = (await first.json()) as { data: Record<string, unknown>[] }
  const second = await door.fetch(startRequest('@/local-llama/ornith'))
  const secondBody = (await second.json()) as { data: Record<string, unknown>[] }
  return {
    firstState: firstBody.data[0]?.state,
    firstStarted: firstBody.data[0]?.started,
    secondState: secondBody.data[0]?.state,
    secondStarted: secondBody.data[0]?.started,
  }
}

describe('POST /engined/v1/start', () => {
  test('an engine id is not a place: the old per-engine route is a 404', async () => {
    const { cfg, root } = llamaDoorConfig(TEST_ROOT)
    const door = createLlamaDoor(cfg, root)
    const res = await door.fetch(
      new Request('http://engined/engined/v1/engines/local-llama/start', { method: 'POST' }),
    )
    expect(res.status).toBe(404)
  })

  test("a chain name warms only its first hop's local engine, with no url in the response", async () => {
    const { cfg, root } = llamaThenWhisperChainConfig()
    const { client, urls } = makeRecordingLlamaClient()
    const runLog: string[][] = []
    const door = createLlamaDoor(
      cfg,
      root,
      { llamaHttpClient: client },
      buildExec({ runLog, portSeed: 52_000 }),
    )
    const res = await door.fetch(startRequest('chain-x'))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { object: string; data: Record<string, unknown>[] }
    expect(body.data).toHaveLength(1)
    const [row] = body.data
    expect(row?.engine).toBe('local-llama')
    expect(row?.state).toBe('running')
    expect(row).not.toHaveProperty('private_url')
    expect(row).not.toHaveProperty('url')
    expect(urls.some((u) => u.endsWith('/models/load'))).toBe(true)
    // The chain's second hop is whisper -- fan-out is the first hop's local
    // route only, so its container must never have been started.
    expect(runLog.some((argv) => argv.some((a) => a.includes('whisper-like')))).toBe(false)
  })

  test('an address whose upstream is not local is a no-op that reports state, not an error', async () => {
    const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
    const cfg = config({
      upstreams: [
        { id: 'openrouter', egress: 'remote', base_url: 'https://openrouter.example/v1' },
      ],
      engines: [engine({ id: 'hosted', kind: 'openai-http' })],
      routes: [route({ engine: 'hosted', model: 'gpt-x', upstream: 'openrouter' })],
    })
    const door = createLlamaDoor(cfg, root)
    const res = await door.fetch(startRequest('@/hosted/gpt-x'))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Record<string, unknown>[] }
    const [row] = body.data
    expect(row?.upstream).toBe('openrouter')
    expect(String(row?.fix)).toContain('not local')
    expect(row).not.toHaveProperty('private_url')
  })
})

describe("POST /engined/v1/start: which of an engine's routes", () => {
  test('a chain hop warms the route it will dispatch to, not the first declared', async () => {
    const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
    const cfg = config({
      upstreams: [
        { id: 'openrouter', egress: 'remote', base_url: 'https://openrouter.example/v1' },
      ],
      engines: [engine({ id: 'hosted', kind: 'openai-http' })],
      // Declaration order puts the keyed upstream first; the ambient route is
      // the one a dispatch of "@/hosted/gpt-x" runs.
      routes: [
        route({ engine: 'hosted', model: 'gpt-x', upstream: 'openrouter' }),
        route({ engine: 'hosted', model: 'gpt-x', upstream: null }),
      ],
      chains: { 'chain-x': ['@/hosted/gpt-x'] },
    })
    const door = createLlamaDoor(cfg, root)
    const res = await door.fetch(startRequest('chain-x'))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Record<string, unknown>[] }
    const [row] = body.data
    expect(row?.upstream).toBeNull()
  })
})

describe('POST /engined/v1/start: the started field', () => {
  test('is true only on the call that launches the engine', async () => {
    const flags = await startedFlagsAcrossTwoCalls()
    expect(flags.firstState).toBe('running')
    expect(flags.firstStarted).toBe(true)
    expect(flags.secondState).toBe('running')
    expect(flags.secondStarted).toBe(false)
  })
})

describe('POST /engined/v1/start: concurrent calls on a cold container engine', () => {
  /**
   * Two `POST /start` calls racing on one never-started container engine.
   * Before this fix each read `state === "running"` before its own launch
   * attempt, so both saw "not running yet" and both reported `started:
   * true` even though the lifecycle's start lock (`docker.ts`) let only one
   * of them actually spawn the container.
   */
  test('exactly one of two concurrent starts reports started: true', async () => {
    const { cfg, root } = whisperDoorConfig()
    const runLog: string[][] = []
    const door = createDoor(cfg, {
      enginesRoot: root,
      bunx: BUNX,
      lifecycle: new DockerLifecycle(
        buildExec({ runLog, portSeed: 52_000, runDelayMs: 40 }),
        READY_200,
      ),
    })

    const [first, second] = await Promise.all([
      door.fetch(startRequest('@/whisper-like/small')),
      door.fetch(startRequest('@/whisper-like/small')),
    ])
    const firstBody = (await first.json()) as { data: Record<string, unknown>[] }
    const secondBody = (await second.json()) as { data: Record<string, unknown>[] }

    expect(runLog).toHaveLength(1)
    const started = [firstBody.data[0]?.started, secondBody.data[0]?.started]
    expect(started.sort()).toEqual([false, true])
    expect(firstBody.data[0]?.state).toBe('running')
    expect(secondBody.data[0]?.state).toBe('running')
  })
})

describe('POST /engined/v1/start: concurrent calls on a cold llama model', () => {
  /**
   * Two `POST /start` calls racing on one never-warmed llama role. Before
   * this fix `startRoute` read `state === "running"` off the registry
   * before its own `warm()` call, so both saw "not running yet" and both
   * reported `started: true` even though only one of them was the caller
   * whose lease actually swapped the resident.
   */
  test('exactly one of two concurrent starts reports started: true', async () => {
    const { cfg, root } = llamaDoorConfig(TEST_ROOT)
    const { client, urls } = makeRecordingLlamaClient()
    const door = createLlamaDoor(cfg, root, { llamaHttpClient: client })

    const [first, second] = await Promise.all([
      door.fetch(startRequest('@/local-llama/ornith')),
      door.fetch(startRequest('@/local-llama/ornith')),
    ])
    const firstBody = (await first.json()) as { data: Record<string, unknown>[] }
    const secondBody = (await second.json()) as { data: Record<string, unknown>[] }

    expect(urls.filter((u) => u.endsWith('/models/load'))).toHaveLength(1)
    const started = [firstBody.data[0]?.started, secondBody.data[0]?.started]
    expect(started.sort()).toEqual([false, true])
    expect(firstBody.data[0]?.state).toBe('running')
    expect(secondBody.data[0]?.state).toBe('running')
  })
})

describe('POST /engined/v1/start: a roleless model on a container engine', () => {
  test('a roleless model on a container engine takes the stop-and-restart path, not the llama router', async () => {
    const { cfg, root } = whisperDoorConfig()
    const { client, urls } = makeRecordingLlamaClient()
    const runLog: string[][] = []
    const door = createLlamaDoor(
      cfg,
      root,
      { llamaHttpClient: client },
      buildExec({ runLog, portSeed: 52_000 }),
    )
    const res = await door.fetch(startRequest('@/whisper-like/small'))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Record<string, unknown>[] }
    expect(body.data[0]?.state).toBe('running')
    expect(runLog).toHaveLength(1)
    const argv = runLog[0] as string[]
    expect(argv[argv.indexOf('-m') + 1]).toBe('/models/small.bin')
    // The llama router's own HTTP client is never touched by an stt start.
    expect(urls).toHaveLength(0)
  })

  test('held leases return 409 and do not restart', async () => {
    const { cfg, root } = whisperDoorConfig(
      route({ engine: 'whisper-like', upstream: 'local', model: 'big', filename: 'big.bin' }),
    )
    const runLog: string[][] = []
    const stopLog: string[][] = []
    const lifecycle = new DockerLifecycle(
      buildExec({ runLog, stopLog, portSeed: 52_000 }),
      READY_200,
    )
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, lifecycle },
      { llamaPresetHostPath: tempPresetPath(TEST_ROOT) },
    )

    const started = await door.fetch(startRequest('@/whisper-like/small'))
    expect(started.status).toBe(200)
    expect(runLog).toHaveLength(1)
    lifecycle.beginLease('whisper-like')

    const res = await door.fetch(startRequest('@/whisper-like/big'))
    expect(res.status).toBe(409)
    expect(runLog).toHaveLength(1)
    expect(stopLog).toHaveLength(0)
  })
})
