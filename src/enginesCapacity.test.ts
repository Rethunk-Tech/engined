import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { DockerLifecycle, type Probe } from './docker.ts'
import { EngineRegistry } from './engines.ts'
import {
  initTestRoot,
  newEnginesRoot,
  OK_EXEC,
  PULLED_CONTAINER,
  registry,
} from './enginesFixtures.ts'
import { errMessage } from './records.ts'
import type { EngineStatus } from './responses.ts'
import {
  BUNX,
  buildExec,
  config,
  ENGINES_ROOT,
  engine,
  makeTestRoot,
  route,
  writeEngineSpec,
} from './test-support.ts'

initTestRoot('engined-capacity-test-')
const CONFIG_ROOT = makeTestRoot('engined-capacity-config-')

const TTS_SPEC = `
kind = "tts"
upstream = "self"
image = "ghcr.io/example/tts@sha256:aaaa"
obtain = "pull"
serves = ["/openai/v1/audio/speech"]
command = []

[ready]
path = "/health"
status = 200
`

const COMFY_CONTAINER_PORT = 8188
const READY: Probe = () => Promise.resolve({ status: 200 })
const POLL_MS = 15
const LIST_BUDGET_MS = 250

async function listed(reg: EngineRegistry, id: string): Promise<EngineStatus> {
  const found = (await reg.list()).engines.find((e) => e.id === id)
  if (found === undefined) {
    throw new Error(`no engine ${id}`)
  }
  return found
}
describe('max_concurrent', () => {
  test('a tts engine engined runs reports 1, and a spec-less tts engine reports none', async () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'speaker', TTS_SPEC)
    const reg = registry(
      config({ engines: [engine({ id: 'speaker' }), engine({ id: 'remote-tts', kind: 'tts' })] }),
      root,
    )
    expect((await listed(reg, 'speaker')).max_concurrent).toBe(1)
    expect(await listed(reg, 'remote-tts')).not.toHaveProperty('max_concurrent')
  })

  test('a local llama engine reports its most generous route, with auto meaning the child four', async () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'llama', PULLED_CONTAINER)
    const llama = (routes: ReturnType<typeof route>[], args = {}) =>
      registry(config({ engines: [engine({ id: 'llama', models_dir: '/m', args })], routes }), root)
    const chat = (model: string, args: Record<string, unknown>) =>
      route({ engine: 'llama', model, role: 'chat', filename: `${model}.gguf`, args })

    const mixed = llama([chat('a', { parallel: 2 }), chat('b', { parallel: 6 })])
    expect((await listed(mixed, 'llama')).max_concurrent).toBe(6)

    const auto = llama([chat('a', { parallel: -1 })])
    expect((await listed(auto, 'llama')).max_concurrent).toBe(4)

    const engineLevel = llama([chat('a', {})], { parallel: 3 })
    expect((await listed(engineLevel, 'llama')).max_concurrent).toBe(3)

    const noRoutes = llama([])
    expect(await listed(noRoutes, 'llama')).not.toHaveProperty('max_concurrent')
  })

  test('a remote openai-http engine reports none', async () => {
    const reg = registry(
      config({ engines: [engine({ id: 'hosted', kind: 'openai-http' })] }),
      newEnginesRoot(),
    )
    expect(await listed(reg, 'hosted')).not.toHaveProperty('max_concurrent')
  })
})

describe('languages', () => {
  test('are reported verbatim when the engine declares them, and absent otherwise', async () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'multi', TTS_SPEC)
    writeEngineSpec(root, 'plain', TTS_SPEC)
    const reg = registry(
      config({
        engines: [engine({ id: 'multi', languages: ['en', 'pt-BR'] }), engine({ id: 'plain' })],
      }),
      root,
    )
    expect((await listed(reg, 'multi')).languages).toEqual(['en', 'pt-BR'])
    expect(await listed(reg, 'plain')).not.toHaveProperty('languages')
  })

  test('the config key parses, refuses a malformed code, and is refused on a non-tts engine', () => {
    const load = (toml: string) => {
      const path = join(mkdtempSync(join(CONFIG_ROOT, 'c-')), 'config.toml')
      Bun.write(path, toml)
      return loadConfig(path)
    }
    const parsed = load('[[engine]]\nid = "t"\nlanguages = ["en", "zh-Hant-TW"]\n')
    expect(parsed.engines[0]?.languages).toEqual(['en', 'zh-Hant-TW'])

    let message = ''
    try {
      load('[[engine]]\nid = "t"\nlanguages = ["english please"]\n')
    } catch (err) {
      message = errMessage(err)
    }
    expect(message).toContain('not a BCP-47 language code')

    const root = newEnginesRoot()
    writeEngineSpec(root, 'llama', PULLED_CONTAINER)
    expect(() =>
      registry(config({ engines: [engine({ id: 'llama', languages: ['en'] })] }), root),
    ).toThrow('sets "languages", but it is a openai-http engine')
  })
})

/** The comfy surface the registry reaches over HTTP: the queue it polls and the object_info it is asked for. */
function comfyStub(objectInfo: 'serve' | 'hang' | 'refuse') {
  const answers: Record<string, unknown> = {
    SaveImage: {},
    SaveVideo: {},
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } },
    UNETLoader: { input: { required: { unet_name: [['wan2.2_i2v.safetensors']] } } },
  }
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname === '/queue') {
        return Response.json({ queue_running: [], queue_pending: [] })
      }
      if (objectInfo === 'hang') {
        await new Promise(() => undefined)
      }
      if (objectInfo === 'refuse') {
        return new Response('nope', { status: 500 })
      }
      const node = pathname.split('/').pop() ?? ''
      return Response.json(node in answers ? { [node]: answers[node] } : {})
    },
  })
}

async function withComfy(
  stub: ReturnType<typeof comfyStub>,
  body: (reg: EngineRegistry) => Promise<void>,
): Promise<void> {
  const lifecycle = new DockerLifecycle(
    buildExec({ port: stub.port, containerPort: COMFY_CONTAINER_PORT }),
    READY,
  )
  const reg = new EngineRegistry(
    config({ engines: [engine({ id: 'comfy', idle_stop_seconds: 600, ready_timeout_s: 5 })] }),
    { enginesRoot: ENGINES_ROOT, bunx: BUNX, lifecycle, comfyPollIntervalMs: POLL_MS },
  )
  try {
    await body(reg)
  } finally {
    await reg.shutdown()
    stub.stop(true)
  }
}

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 3000
  let value = await read()
  while (value === undefined && Date.now() < deadline) {
    await Bun.sleep(POLL_MS)
    value = await read()
  }
  if (value === undefined) {
    throw new Error('timed out')
  }
  return value
}

describe('comfy output and checkpoints', () => {
  test('absent while comfy is down, present once it runs, and dropped when it stops', async () => {
    await withComfy(comfyStub('serve'), async (reg) => {
      const down = await listed(reg, 'comfy')
      expect(down.max_concurrent).toBe(1)
      expect(down).not.toHaveProperty('output')
      expect(down).not.toHaveProperty('checkpoints')

      await reg.start('comfy')
      const up = await until(async () => {
        const status = await listed(reg, 'comfy')
        return status.output === undefined ? undefined : status
      })
      expect(up.output).toEqual(['image', 'video'])
      expect(up.checkpoints).toEqual({
        image: ['sdxl.safetensors'],
        video: ['wan2.2_i2v.safetensors'],
      })

      await reg.stop('comfy')
      const stopped = await listed(reg, 'comfy')
      expect(stopped).not.toHaveProperty('output')
      expect(stopped).not.toHaveProperty('checkpoints')
    })
  })

  test('stay absent when object_info fails, and the listing is not held up by one that hangs', async () => {
    for (const objectInfo of ['refuse', 'hang'] as const) {
      await withComfy(comfyStub(objectInfo), async (reg) => {
        await reg.start('comfy')
        await Bun.sleep(POLL_MS * 6)
        const began = performance.now()
        const status = await listed(reg, 'comfy')
        expect(performance.now() - began).toBeLessThan(LIST_BUDGET_MS)
        expect(status.state).toBe('running')
        expect(status).not.toHaveProperty('output')
        expect(status).not.toHaveProperty('checkpoints')
      })
    }
  })
})

test('a comfy engine that was never started lists instantly', async () => {
  const reg = new EngineRegistry(config({ engines: [engine({ id: 'comfy' })] }), {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    exec: OK_EXEC,
  })
  try {
    const began = performance.now()
    await reg.list()
    expect(performance.now() - began).toBeLessThan(LIST_BUDGET_MS)
  } finally {
    await reg.shutdown()
  }
})
