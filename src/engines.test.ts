import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import type { QueueSnapshot } from './comfyQueue.ts'
import { DockerLifecycle, type Probe } from './docker.ts'
import { buildRunArgs } from './dockerArgs.ts'
import { EngineRegistry } from './engines.ts'
import {
  MISSING_ARTIFACT_EXEC,
  NO_IMAGE_EXEC,
  newEnginesRoot,
  noImageExec,
  OK_EXEC,
  PULLED_CONTAINER,
  redirectStateHome,
  registry,
  STT_REAL_COMMAND,
  STT_VOLUME_ARTIFACT,
  setupKokoro,
  setupLlama,
  specLessProxyEngine,
  TTS_EMPTY_COMMAND,
  useTestRoot,
} from './enginesFixtures.ts'
import { EngineBusyError } from './errors/engineBusy.ts'
import { FatalError } from './errors/fatal.ts'
import type { Exec } from './exec.ts'
import type { RuntimeStatus } from './runtimeTable.ts'
import { loadSpec } from './spec.ts'
import { isContainerSpec } from './specTypes.ts'
import {
  BUNX,
  buildExec,
  config,
  containerRunning,
  ENGINES_ROOT,
  engine,
  route,
  upstream,
  writeEngineSpec,
} from './test-support.ts'
import type { Config, EngineEntry } from './types.ts'

useTestRoot('engined-engines-test-')

const RX_DISABLED_START = /is disabled in config/
const RX_NO_ENDPOINT = /engine "img".*serves no endpoint to ask it through/
const RX_MISSING_ROLE = /missing required "role"/
const RX_MISSING_FILENAME = /missing required "filename"/
const RX_FORBIDDEN_TRANSLATE = /must not declare "translate"/

/** Records what `reload` asks to be torn down; a disabling reload must ask. */
class RemovalSpy extends DockerLifecycle {
  readonly removed: string[] = []
  override removeEngine(id: string): Promise<void> {
    this.removed.push(id)
    return super.removeEngine(id)
  }
}

describe('disabled engines', () => {
  test('are reported as disabled and unavailable, are never probed, and refuse to start', async () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'llama', PULLED_CONTAINER)
    const execLog: string[][] = []
    const reg = registry(config({ engines: [engine({ id: 'llama', disabled: true })] }), root, {
      exec: (args) => {
        execLog.push([...args])
        return OK_EXEC(args)
      },
    })

    const listed = (await reg.list()).engines.find((e) => e.id === 'llama')
    expect(listed?.disabled).toBe(true)
    expect(listed?.state).toBe('unavailable')
    // Its real spec, not a guess: the engine is off, not unknown.
    expect(listed?.kind).toBe('openai-http')
    expect(listed?.serves).toEqual(['/openai/v1/chat/completions'])
    expect(listed?.fix).toBe('set "disable = false" on engine "llama" in config.toml')
    // list() probes docker for every engine it does not short-circuit.
    expect(execLog).toEqual([])

    expect(reg.get('llama')?.disabled).toBe(true)
    await expect(reg.start('llama')).rejects.toThrow(RX_DISABLED_START)
    expect(execLog).toEqual([])
  })

  test('a route shape that would fail the boot is not checked on a disabled engine', () => {
    // The escape hatch has to reach the check that refuses the boot: an
    // engine nothing may start or route to cannot be why the daemon is down.
    const root = newEnginesRoot()
    writeEngineSpec(root, 'llama-like', PULLED_CONTAINER)
    const reg = registry(
      config({
        engines: [engine({ id: 'llama-like', models_dir: '/data/gguf', disabled: true })],
        routes: [
          route({ engine: 'llama-like', upstream: 'local', model: 'x', filename: 'x.gguf' }),
        ],
      }),
      root,
    )
    expect(reg.get('llama-like')?.disabled).toBe(true)
  })

  test('a reload that disables an engine tears its container down like a removal', () => {
    // The entry survives a disabling reload, so the removal that a dropped
    // engine gets for free has to be asked for -- this is that ask.
    const removed = removedByReload(
      config({ engines: [engine({ id: 'llama' })] }),
      config({ engines: [engine({ id: 'llama', disabled: true })] }),
    )
    expect(removed).toEqual(['llama'])
  })
})

test("a status probe carries the engine's own idle-stop, so an adopted orphan counts down on the configured one", async () => {
  const root = newEnginesRoot()
  writeEngineSpec(root, 'llama', PULLED_CONTAINER)
  // Records the idle-stop each status probe is handed -- what an adopted orphan's countdown is armed from.
  const lifecycle = new DockerLifecycle(OK_EXEC, READY_PROBE)
  const idleStops: (number | undefined)[] = []
  const probe = lifecycle.probe.bind(lifecycle)
  lifecycle.probe = (id, spec, specSource, idleStopSeconds): Promise<RuntimeStatus> => {
    idleStops.push(idleStopSeconds)
    return probe(id, spec, specSource, idleStopSeconds)
  }
  const reg = registry(
    config({ engines: [engine({ id: 'llama', idle_stop_seconds: 42 })] }),
    root,
    { lifecycle },
  )

  await reg.list()

  expect(idleStops).toEqual([42])
})

test('a reload teardown that fails is reported, not swallowed', async () => {
  const root = newEnginesRoot()
  writeEngineSpec(root, 'llama', PULLED_CONTAINER)
  const written: string[] = []
  const realWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stderr.write

  try {
    // Every teardown a reload asks for fails, the way an unreachable docker daemon fails one.
    const lifecycle = new DockerLifecycle(OK_EXEC)
    lifecycle.removeEngine = () => Promise.reject(new Error('docker daemon unreachable'))
    registry(config({ engines: [engine({ id: 'llama' })] }), root, { lifecycle }).reload(
      config({ engines: [] }),
    )
    // The teardown runs in the background: `reload` is synchronous.
    await Promise.resolve()
  } finally {
    process.stderr.write = realWrite
  }

  expect(written.join('')).toContain('llama')
  expect(written.join('')).toContain('docker daemon unreachable')
})

/** Builds a registry over a pulled `llama` from `before`, reloads it with `after`, and reports what was torn down. */
function removedByReload(before: Config, after: Config): string[] {
  const root = newEnginesRoot()
  writeEngineSpec(root, 'llama', PULLED_CONTAINER)
  const lifecycle = new RemovalSpy(OK_EXEC)
  registry(before, root, { lifecycle }).reload(after)
  return lifecycle.removed
}

describe("reloading an engine's route binding", () => {
  test("a reload that repoints an engine's route away from local tears its container down without changing its id", () => {
    // The id diff alone would miss this: "llama" survives into the new
    // config unchanged, and only its route's own upstream moved.
    const removed = removedByReload(
      config({
        engines: [engine({ id: 'llama' })],
        upstreams: [upstream({ id: 'peer', egress: 'lan' })],
        routes: [route({ engine: 'llama', model: 'm', upstream: 'local' })],
      }),
      config({
        engines: [engine({ id: 'llama' })],
        upstreams: [upstream({ id: 'peer', egress: 'lan' })],
        routes: [route({ engine: 'llama', model: 'm', upstream: 'peer' })],
      }),
    )
    expect(removed).toEqual(['llama'])
  })

  test("a reload that keeps an engine's local binding does not tear its container down", () => {
    const removed = removedByReload(
      config({
        engines: [engine({ id: 'llama' })],
        routes: [route({ engine: 'llama', model: 'm', upstream: 'local' })],
      }),
      config({
        engines: [engine({ id: 'llama', idle_stop_seconds: 42 })],
        routes: [route({ engine: 'llama', model: 'm', upstream: 'local' })],
      }),
    )
    expect(removed).toEqual([])
  })

  // The bindings-only failure this delivery exists to avoid: an engine with
  // no routes at all (comfy, sometimes) has no binding either way, so a
  // rule that merged the id-diff and binding checks into one would stop
  // managing it silently the moment it had zero routes -- still typechecking,
  // still constructing, and never torn down or reported missing.
  test('an engine with no routes at all has no binding to lose, and an unrelated reload does not spuriously tear it down', () => {
    const removed = removedByReload(
      config({ engines: [engine({ id: 'llama' })], routes: [] }),
      config({ engines: [engine({ id: 'llama', idle_stop_seconds: 42 })], routes: [] }),
    )
    expect(removed).toEqual([])
  })
})

describe('unavailable engines', () => {
  test('missing image is unavailable and names the pull command for a digest-pinned image, and never starts a container', async () => {
    const runLog: string[][] = []
    const trackingExec: Exec = (args) => {
      if (args[0] === 'run') {
        runLog.push([...args])
      }
      return noImageExec(args)
    }
    const { reg } = setupLlama({ exec: trackingExec })
    // get() is the sync accessor and does not probe docker cold; list() does.
    expect(reg.get('llama')?.state).toBe('installed')
    const listed = (await reg.list()).engines.find((e) => e.id === 'llama')
    expect(listed?.state).toBe('unavailable')
    expect(listed?.fix).toBe('docker pull ghcr.io/example/llama@sha256:aaaa')
    expect(runLog.length).toBe(0)
  })

  test('missing image with a Dockerfile in its spec dir names a runnable docker build', async () => {
    const { root, reg } = setupKokoro(NO_IMAGE_EXEC)
    writeFileSync(join(root, 'kokoro', 'Dockerfile'), 'FROM scratch\n')
    const listed = (await reg.list()).engines.find((e) => e.id === 'kokoro')
    expect(listed?.state).toBe('unavailable')
    expect(listed?.fix).toBe(
      `docker build -t engined/kokoro:local -f ${join(root, 'kokoro', 'Dockerfile')} ${join(root, 'kokoro')}`,
    )
  })

  test('missing image with NO Dockerfile in its spec dir does not invent a build command', async () => {
    // llama's real shape: obtain = "build", no Dockerfile shipped here
    // because the image is built from a different repository entirely.
    const { reg } = setupKokoro(NO_IMAGE_EXEC)
    const listed = (await reg.list()).engines.find((e) => e.id === 'kokoro')
    expect(listed?.state).toBe('unavailable')
    expect(listed?.fix).not.toContain('docker build')
    expect(listed?.fix).toContain('engined/kokoro:local')
  })

  test('missing artifact is unavailable and names the command that supplies it, via start()', async () => {
    const { reg } = setupKokoro(MISSING_ARTIFACT_EXEC)
    const status = await reg.start('kokoro')
    expect(status.state).toBe('unavailable')
    expect(status.fix).toContain('curlimages/curl')
  })
})

/**
 * Discovering this by trying costs a 502 on every streamed request, and the
 * alternative -- a hardcoded engine list per consumer -- goes stale the moment
 * engined gains an engine. So it is reported where the engines are defined.
 */
describe('streaming capability', () => {
  function ttsSpec(streaming: boolean): string {
    return `
kind = "tts"
upstream = "self"
image = "ghcr.io/example/tts@sha256:aaaa"
obtain = "pull"
serves = ["/openai/v1/audio/speech"]
command = []
${streaming ? 'streaming = true' : ''}

[ready]
path = "/health"
status = 200
`
  }

  test('reported per tts engine, and a real false on a kind with no chunk contract to declare', async () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'chunker', ttsSpec(true))
    writeEngineSpec(root, 'blocker', ttsSpec(false))
    writeEngineSpec(root, 'llama', PULLED_CONTAINER)
    const reg = registry(
      config({
        engines: [engine({ id: 'chunker' }), engine({ id: 'blocker' }), engine({ id: 'llama' })],
      }),
      root,
    )

    const listed = await reg.list()
    const streamingOf = (id: string) => listed.engines.find((e) => e.id === id)?.streaming
    expect(streamingOf('chunker')).toBe(true)
    expect(streamingOf('blocker')).toBe(false)
    // An openai-http engine has no /openai/v1/audio/speech to stream on,
    // and now that every kind can answer the question, its truthful answer
    // is a real `false` rather than an `undefined` that reads as "unknown".
    expect(streamingOf('llama')).toBe(false)
  })
})

describe('installed engines', () => {
  test('an engine merely stopped is installed, never reported as broken, and carries no container address', async () => {
    const { reg } = setupLlama()
    const listed = (await reg.list()).engines.find((e) => e.id === 'llama')
    expect(listed?.state).toBe('installed')
    expect(listed).not.toHaveProperty('private_url')
    expect(listed?.fix).toBeUndefined()
  })

  test('neither get() nor list() ever carries a container address, before any start or after', async () => {
    const lifecycle = new DockerLifecycle(OK_EXEC)
    const { reg } = setupLlama({ lifecycle })
    expect(reg.get('llama')).not.toHaveProperty('private_url')
    const listed = (await reg.list()).engines.find((e) => e.id === 'llama')
    expect(listed).not.toHaveProperty('private_url')
  })
})

describe("a route's capability fields reach GET /engined/v1/engines", () => {
  test('one entry per model-bearing route, a disabled route excluded, and no entry for the engine when none of its routes name a model or a field', async () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'llama', PULLED_CONTAINER)
    const reg = registry(
      config({
        engines: [engine({ id: 'llama' })],
        routes: [
          route({
            engine: 'llama',
            model: 'ornith',
            upstream: 'local',
            input: ['text'],
            output: ['text'],
            context_in: 8192,
          }),
          route({ engine: 'llama', model: 'sonnet-5', upstream: 'local', output: ['text'] }),
          route({
            engine: 'llama',
            model: 'off',
            upstream: 'local',
            output: ['text'],
            disabled: true,
          }),
        ],
      }),
      root,
    )

    const listed = (await reg.list()).engines.find((e) => e.id === 'llama')
    expect(listed?.capabilities).toMatchObject([
      { model: 'ornith', input: ['text'], output: ['text'], context_in: 8192 },
      { model: 'sonnet-5', output: ['text'] },
    ])
    // A roleless route serves whatever its engine serves, per entry.
    const engineServes = listed?.serves ?? []
    expect(listed?.capabilities?.map((c) => c.serves)).toEqual([engineServes, engineServes])
  })

  test('an engine with no model-bearing or capability-declaring routes reports no capabilities at all', async () => {
    const { reg } = setupLlama()
    const listed = (await reg.list()).engines.find((e) => e.id === 'llama')
    expect(listed?.capabilities).toBeUndefined()
  })
})

/**
 * A capability is not a served endpoint: `serves` says what the door
 * answers, and a route may declare capability fields on an engine whose
 * spec serves nothing at all to ask them through. Checked at registry
 * construction, the same tier as the wire and self-upstream checks above --
 * `serves` comes from the loaded spec, which is not known until here.
 */
describe('a declared capability whose endpoint is unserved fails at startup', () => {
  test('a route declaring a capability on a spec-less engine with an empty serves list fails, naming the engine and its kind', () => {
    const cfg = config({
      engines: [engine({ id: 'img', kind: 'comfy' })],
      routes: [route({ engine: 'img', model: undefined, upstream: 'local', output: ['image'] })],
    })
    expect(() => registry(cfg, newEnginesRoot())).toThrow(FatalError)
    expect(() => registry(cfg, newEnginesRoot())).toThrow(RX_NO_ENDPOINT)
  })

  test('the same engine with no capability-declaring route constructs clean', () => {
    const cfg = config({
      engines: [engine({ id: 'img', kind: 'comfy' })],
      routes: [route({ engine: 'img', model: undefined, upstream: 'local' })],
    })
    expect(() => registry(cfg, newEnginesRoot())).not.toThrow()
  })
})

describe('serves()', () => {
  test("returns the loaded spec's serves list for a container engine", () => {
    const { reg } = setupLlama()
    expect(reg.serves('llama')).toEqual(['/openai/v1/chat/completions'])
  })

  test('falls back to the kind-serves table for a spec-less proxy engine', () => {
    const reg = registry(config({ engines: [specLessProxyEngine('scribe')] }), newEnginesRoot())
    expect(reg.serves('scribe')).toEqual(['/openai/v1/audio/transcriptions'])
  })

  test('unknown id serves nothing rather than throwing', () => {
    const reg = registry(config({ engines: [] }), newEnginesRoot())
    expect(reg.serves('nope')).toEqual([])
  })
})

describe('the kind-dependent filename/role split runs at registry construction, not parse', () => {
  test('a whisper-shaped route (filename, no role) parses and is accepted', () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'whisper-like', STT_REAL_COMMAND)
    const reg = registry(
      config({
        engines: [engine({ id: 'whisper-like', models_dir: '/data/whisper' })],
        routes: [
          route({ engine: 'whisper-like', upstream: 'local', model: 'x', filename: 'x.bin' }),
        ],
      }),
      root,
    )
    expect(reg.serves('whisper-like')).toEqual(['/openai/v1/audio/transcriptions'])
  })

  test('a llama-shaped route without role still fails, at construction', () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'llama-like', PULLED_CONTAINER)
    expect(
      () =>
        new EngineRegistry(
          config({
            engines: [engine({ id: 'llama-like', models_dir: '/data/gguf' })],
            routes: [
              route({ engine: 'llama-like', upstream: 'local', model: 'x', filename: 'x.gguf' }),
            ],
          }),
          { enginesRoot: root, bunx: BUNX },
        ),
    ).toThrow(RX_MISSING_ROLE)
  })

  // Only an stt route can mean anything by it. A llama route carrying the key
  // would read as a promise the door never consults, since translations is not
  // a path that engine serves at all.
  test('a llama-shaped route declaring translate fails at construction', () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'llama-like', PULLED_CONTAINER)
    expect(
      () =>
        new EngineRegistry(
          config({
            engines: [engine({ id: 'llama-like', models_dir: '/data/gguf' })],
            routes: [
              route({
                engine: 'llama-like',
                upstream: 'local',
                model: 'x',
                filename: 'x.gguf',
                role: 'chat',
                translate: true,
              }),
            ],
          }),
          { enginesRoot: root, bunx: BUNX },
        ),
    ).toThrow(RX_FORBIDDEN_TRANSLATE)
  })

  test('@/llama/sonnet-5 stays invalid: a filename-less llama route fails at construction', () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'llama-like', PULLED_CONTAINER)
    expect(
      () =>
        new EngineRegistry(
          config({
            engines: [engine({ id: 'llama-like', models_dir: '/data/gguf' })],
            routes: [route({ engine: 'llama-like', upstream: 'local', model: 'sonnet-5' })],
          }),
          { enginesRoot: root, bunx: BUNX },
        ),
    ).toThrow(RX_MISSING_FILENAME)
  })
})

/** ComfyUI's own listen port, which its image is the one to `EXPOSE`. */
const COMFY_CONTAINER_PORT = 8188

describe('comfy: shipped spec', () => {
  test('the run argv takes GPU_FLAGS, label=disable and latent2rgb, and publishes to no wildcard interface', () => {
    const loaded = loadSpec(engine({ id: 'comfy' }), {
      enginesRoot: ENGINES_ROOT,
      bunx: BUNX,
    })
    const { spec } = loaded
    if (!isContainerSpec(spec)) {
      throw new Error('engines/comfy/spec.toml must be a container spec')
    }
    const argv = buildRunArgs('engined-comfy', spec, COMFY_CONTAINER_PORT)
    expect(argv).toContain('--preview-method')
    expect(argv).toContain('latent2rgb')
    expect(argv).toContain('/dev/kfd')
    expect(argv).toContain('/dev/dri')
    expect(argv).toContain('label=disable')
    expect(argv).not.toContain('-P')
    expect(argv.some((a) => a.startsWith('0.0.0.0::'))).toBe(false)
  })
})

/** The docker calls the registry makes to get `comfy` into `state: "running"`; each `docker port` lookup answers a different host port, none of which any assertion reads. */
function comfyExec(): Exec {
  return buildExec({ portSeed: 40_000, containerPort: COMFY_CONTAINER_PORT })
}

const READY_PROBE: Probe = () => Promise.resolve({ status: 200 })

const EMPTY_QUEUE: QueueSnapshot = { queue_running: [], queue_pending: [] }
const BUSY_QUEUE: QueueSnapshot = { queue_running: [{ id: 'job-1' }], queue_pending: [] }

function comfyConfig(): Config {
  return config({
    engines: [engine({ id: 'comfy', idle_stop_seconds: 0.05, ready_timeout_s: 5 })],
  })
}

/** Builds a comfy-backed registry from the given fixtures, runs `body` against it, and always shuts it down. */
async function withComfyRegistry(
  opts: {
    exec: Exec
    cfg: Config
    queueFetch: () => Promise<QueueSnapshot>
    comfyPollIntervalMs: number
  },
  body: (reg: EngineRegistry, lifecycle: DockerLifecycle) => Promise<void> | void,
): Promise<void> {
  const lifecycle = new DockerLifecycle(opts.exec, READY_PROBE)
  const reg = new EngineRegistry(opts.cfg, {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    lifecycle,
    queueFetch: opts.queueFetch,
    comfyPollIntervalMs: opts.comfyPollIntervalMs,
  })
  try {
    await body(reg, lifecycle)
  } finally {
    await reg.shutdown()
  }
}

describe('comfy: idle timer driven by /queue polling', () => {
  test('an empty queue advances the idle timer to a real stop', async () => {
    await withComfyRegistry(
      {
        exec: comfyExec(),
        cfg: comfyConfig(),
        queueFetch: () => Promise.resolve(EMPTY_QUEUE),
        comfyPollIntervalMs: 15,
      },
      async (reg, lifecycle) => {
        const started = await reg.start('comfy')
        expect(started.state).toBe('running')
        expect(lifecycle.getStatus('comfy').private_url).not.toBeNull()

        await Bun.sleep(300)

        const after = reg.get('comfy')
        expect(after?.state).toBe('installed')
        expect(lifecycle.getStatus('comfy').private_url).toBeNull()
      },
    )
  })

  test('a non-empty queue never lets the idle timer fire', async () => {
    await withComfyRegistry(
      {
        exec: comfyExec(),
        cfg: comfyConfig(),
        queueFetch: () => Promise.resolve(BUSY_QUEUE),
        comfyPollIntervalMs: 15,
      },
      async (reg, lifecycle) => {
        const started = await reg.start('comfy')
        expect(started.state).toBe('running')

        await Bun.sleep(300)

        const after = reg.get('comfy')
        expect(after?.state).toBe('running')
        expect(lifecycle.getStatus('comfy').private_url).not.toBeNull()
      },
    )
  })
})

describe('comfy: the lease a busy queue takes', () => {
  test('a queue that turns busy takes the lease in the same tick it is observed, with no awaited docker work in between', async () => {
    const execLog: string[][] = []
    const base = comfyExec()
    const exec: Exec = (args) => {
      execLog.push([...args])
      return base(args)
    }
    let busy = false
    await withComfyRegistry(
      {
        exec,
        cfg: config({
          engines: [engine({ id: 'comfy', idle_stop_seconds: 30, ready_timeout_s: 5 })],
        }),
        queueFetch: () => Promise.resolve(busy ? BUSY_QUEUE : EMPTY_QUEUE),
        comfyPollIntervalMs: 15,
      },
      async (reg, lifecycle) => {
        await reg.start('comfy')
        await Bun.sleep(60)
        const settled = execLog.length

        busy = true
        await Bun.sleep(90)

        // Every docker call the transition awaits is a window in which the
        // container holds no lease and no countdown: a model switch landing
        // there stops a comfy that has just been observed working.
        expect(execLog.slice(settled)).toEqual([])
        expect(lifecycle.getStatus('comfy').active_leases).toBe(1)
        expect(lifecycle.getStatus('comfy').state).toBe('running')
      },
    )
  })
})

describe('comfy: resolved URL outlives its container by exactly nothing', () => {
  test('two successive starts yield two different private_url values', async () => {
    await withComfyRegistry(
      {
        exec: comfyExec(),
        cfg: comfyConfig(),
        queueFetch: () => Promise.resolve(EMPTY_QUEUE),
        comfyPollIntervalMs: 60_000,
      },
      async (reg, lifecycle) => {
        await reg.start('comfy')
        const first = lifecycle.getStatus('comfy').private_url
        await lifecycle.removeEngine('comfy')
        await reg.start('comfy')
        const second = lifecycle.getStatus('comfy').private_url

        expect(first).not.toBeNull()
        expect(second).not.toBeNull()
        expect(second).not.toBe(first)
      },
    )
  })
})

/** A lifecycle whose every `docker run` argv lands in `runArgvCalls`; the host port it hands back is never read. */
function capturingLifecycle(runArgvCalls: string[][], containerPort = 8080): DockerLifecycle {
  return new DockerLifecycle(
    buildExec({ portSeed: 50_000, containerPort, runLog: runArgvCalls }),
    READY_PROBE,
  )
}

/** A registry over one engine, its lifecycle wired to `capturingLifecycle` so `runArgvCalls` fills in as `start()` runs it. */
function capturingRegistry(
  entry: EngineEntry,
  containerPort: number,
): { reg: EngineRegistry; runArgvCalls: string[][] } {
  const runArgvCalls: string[][] = []
  const reg = new EngineRegistry(config({ engines: [entry] }), {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    lifecycle: capturingLifecycle(runArgvCalls, containerPort),
  })
  return { reg, runArgvCalls }
}

describe('spec construction is routed through the per-engine builder', () => {
  test('comfy started through the registry carries its models bind mount in the run argv', async () => {
    const { reg, runArgvCalls } = capturingRegistry(
      engine({ id: 'comfy', models_dir: '/data/comfy-models', ready_timeout_s: 5 }),
      COMFY_CONTAINER_PORT,
    )
    try {
      await reg.start('comfy')
      expect(runArgvCalls).toHaveLength(1)
      const [argv] = runArgvCalls
      expect(argv).toContain('-v')
      expect(argv?.some((a) => a === '/data/comfy-models:/opt/comfyui/models')).toBe(true)
    } finally {
      await reg.shutdown()
    }
  })

  test('llama started through the registry carries --models-preset and its :ro mounts', async () => {
    // start() on an openai-http engine with a models_dir renders the preset
    // to stateDir()/llama/preset.ini unconditionally (paths.ts's own
    // llamaPresetPath, not overridable via RegistryOptions) -- the
    // same path the real running engine has bind-mounted.
    const restoreStateHome = redirectStateHome()
    const { reg, runArgvCalls } = capturingRegistry(
      engine({
        id: 'llama',
        models_dir: '/data/gguf',
        models_max: 3,
        ready_timeout_s: 5,
      }),
      8080,
    )
    try {
      await reg.start('llama')
      expect(runArgvCalls).toHaveLength(1)
      const [argv] = runArgvCalls
      expect(argv).toContain('--models-preset')
      expect(argv?.some((a) => a === '/data/gguf:/models:ro')).toBe(true)
      expect(argv?.some((a) => a.includes('llama/preset.ini:/preset.ini:ro'))).toBe(true)
    } finally {
      await reg.shutdown()
      restoreStateHome()
    }
  })
})

// Every `toHaveLength(1)` above reads as "exactly one container started".
// That only holds while the log sees one-shot runs too: an artifact check is
// a `docker run` no fixture above triggers, and a log blind to it would let
// an extra container start pass a length assertion unnoticed.
test('an artifact only a named volume can hold starts its own check container, logged beside the detached start', async () => {
  const root = newEnginesRoot()
  writeEngineSpec(root, 'volume-stt', STT_VOLUME_ARTIFACT)
  const runArgvCalls: string[][] = []
  const reg = new EngineRegistry(
    config({ engines: [engine({ id: 'volume-stt', ready_timeout_s: 5 })] }),
    { enginesRoot: root, bunx: BUNX, lifecycle: capturingLifecycle(runArgvCalls) },
  )
  try {
    await reg.start('volume-stt')
    expect(runArgvCalls).toHaveLength(2)
    const [check, started] = runArgvCalls
    expect(check).toContain('--rm')
    expect(check?.some((a) => a.includes("test -e '/models/fake.bin'"))).toBe(true)
    expect(started?.[1]).toBe('-d')
  } finally {
    await reg.shutdown()
  }
})

const RX_KOKORO_LIKE = /kokoro-like/

// [engine.args] reached argv only via buildLlamaSpec and buildComfySpec --
// every other container kind (tts, stt, any future one) fell through
// loadEngineSpec's `return loaded;` untouched, so args were parsed,
// forbidden-flag-checked at config parse, and then silently dropped.
describe('a container kind with no dedicated builder still gets [engine.args]', () => {
  test("a stt engine's real command carries [engine.args] appended in the run argv", async () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'whisper-like', STT_REAL_COMMAND)
    const runArgvCalls: string[][] = []
    const reg = new EngineRegistry(
      config({
        engines: [engine({ id: 'whisper-like', args: { threads: 4 }, ready_timeout_s: 5 })],
      }),
      {
        enginesRoot: root,
        bunx: BUNX,
        lifecycle: capturingLifecycle(runArgvCalls),
      },
    )
    try {
      await reg.start('whisper-like')
      expect(runArgvCalls).toHaveLength(1)
      const [argv] = runArgvCalls
      const threadsIdx = argv?.indexOf('--threads')
      expect(threadsIdx).toBeGreaterThan(-1)
      expect(argv?.[(threadsIdx as number) + 1]).toBe('4')
      // The spec's own command survives untouched, ahead of the appended args.
      expect(argv).toContain('--host')
    } finally {
      await reg.shutdown()
    }
  })

  /**
   * chatterbox/kokoro's real shape: `command = []` because the image's own
   * CMD is already correct. Appending flags to an EMPTY command array does
   * not extend anything -- `buildRunArgs` pushes `image, ...command`, so an
   * empty command means "run the image's own CMD unmodified" and a
   * non-empty one REPLACES it. Honouring args there would silently corrupt
   * the container's launch, not merely do nothing; rejecting at spec-load
   * is the only shape that gives an operator either the effect or an error.
   */
  test('a tts engine with an image-defined (empty) command rejects non-empty [engine.args] loudly, at construction', () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'kokoro-like', TTS_EMPTY_COMMAND)
    expect(
      () =>
        new EngineRegistry(
          config({
            engines: [engine({ id: 'kokoro-like', args: { foo: 'bar' } })],
          }),
          { enginesRoot: root, bunx: BUNX },
        ),
    ).toThrow(RX_KOKORO_LIKE)
  })

  test('a tts engine with an image-defined (empty) command and NO [engine.args] starts clean', async () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'kokoro-like', TTS_EMPTY_COMMAND)
    const runArgvCalls: string[][] = []
    const reg = new EngineRegistry(
      config({ engines: [engine({ id: 'kokoro-like', ready_timeout_s: 5 })] }),
      {
        enginesRoot: root,
        bunx: BUNX,
        lifecycle: capturingLifecycle(runArgvCalls),
      },
    )
    try {
      await reg.start('kokoro-like')
      expect(runArgvCalls).toHaveLength(1)
    } finally {
      await reg.shutdown()
    }
  })
})

/**
 * Liveness the test can change mid-run: the container under test is up when
 * it starts and dies afterwards, so a fixed answer cannot express it -- a
 * dead-from-the-first-inspect container never reaches `running` at all.
 */
function comfyExecLiveness(live: { alive: boolean }): Exec {
  const base = comfyExec()
  return (args) => {
    if (args[0] === 'inspect') {
      return Promise.resolve(containerRunning(live.alive))
    }
    return base(args)
  }
}

function comfyLongIdleConfig(): Config {
  return config({
    engines: [engine({ id: 'comfy', idle_stop_seconds: 60, ready_timeout_s: 5 })],
  })
}

describe('comfy: a container that dies underneath engined', () => {
  test('a refused /queue poll against a gone container clears the stale running state', async () => {
    const comfyLive = { alive: true }
    await withComfyRegistry(
      {
        exec: comfyExecLiveness(comfyLive),
        cfg: comfyLongIdleConfig(),
        queueFetch: () => Promise.reject(new Error('connect ECONNREFUSED')),
        comfyPollIntervalMs: 15,
      },
      async (reg, lifecycle) => {
        const started = await reg.start('comfy')
        expect(started.state).toBe('running')
        expect(lifecycle.getStatus('comfy').private_url).not.toBeNull()

        comfyLive.alive = false
        await Bun.sleep(300)

        // Never a 200 naming a dead address: the door reports what docker says.
        const after = reg.get('comfy')
        expect(after?.state).toBe('installed')
        expect(lifecycle.getStatus('comfy').private_url).toBeNull()
      },
    )
  })

  test('a refused poll against a container still up leaves it running', async () => {
    await withComfyRegistry(
      {
        exec: comfyExecLiveness({ alive: true }),
        cfg: comfyLongIdleConfig(),
        queueFetch: () => Promise.reject(new Error('socket hang up')),
        comfyPollIntervalMs: 15,
      },
      async (reg, lifecycle) => {
        expect((await reg.start('comfy')).state).toBe('running')

        await Bun.sleep(300)

        const after = reg.get('comfy')
        expect(after?.state).toBe('running')
        expect(lifecycle.getStatus('comfy').private_url).not.toBeNull()
      },
    )
  })
})

/** Mirrors engines/whisper's real shape: a real "-m <path>" pair for `withModelFile` to rewrite. */
const STT_WITH_MODEL_FLAG = `
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

/** A registry over one stt-kind engine with two model-bearing routes, its lifecycle wired to a stop-and-restart-tracking exec fake and handed back so a test can drive leases directly. */
function sttSwitchRegistry(wrap: (base: Exec) => Exec = (base) => base): {
  reg: EngineRegistry
  lifecycle: DockerLifecycle
  runLog: string[][]
  stopLog: string[][]
} {
  const root = newEnginesRoot()
  writeEngineSpec(root, 'whisper-like', STT_WITH_MODEL_FLAG)
  const runLog: string[][] = []
  const stopLog: string[][] = []
  const lifecycle = new DockerLifecycle(
    wrap(buildExec({ runLog, stopLog, portSeed: 51_000 })),
    READY_PROBE,
  )
  const reg = new EngineRegistry(
    config({
      engines: [engine({ id: 'whisper-like', models_dir: '/data/whisper' })],
      routes: [
        route({
          engine: 'whisper-like',
          upstream: 'local',
          model: 'small',
          filename: 'small.bin',
        }),
        route({ engine: 'whisper-like', upstream: 'local', model: 'big', filename: 'big.bin' }),
      ],
    }),
    { enginesRoot: root, bunx: BUNX, lifecycle },
  )
  return { reg, lifecycle, runLog, stopLog }
}

describe('model-bearing stt: switching models is a stop-and-restart', () => {
  test("starting with a model bakes that route's filename into the -m argument", async () => {
    const { reg, runLog } = sttSwitchRegistry()
    try {
      await reg.start('whisper-like', 'small')
      expect(runLog).toHaveLength(1)
      const argv = runLog[0] as string[]
      const idx = argv.indexOf('-m')
      expect(argv[idx + 1]).toBe('/models/small.bin')
    } finally {
      await reg.shutdown()
    }
  })

  test('switching models with no active leases stops the container and restarts it with the new one', async () => {
    const { reg, runLog, stopLog } = sttSwitchRegistry()
    try {
      await reg.start('whisper-like', 'small')
      expect(runLog).toHaveLength(1)
      expect(stopLog).toHaveLength(0)

      await reg.start('whisper-like', 'big')
      expect(stopLog).toHaveLength(1)
      expect(runLog).toHaveLength(2)
      const secondArgv = runLog[1] as string[]
      expect(secondArgv[secondArgv.indexOf('-m') + 1]).toBe('/models/big.bin')
    } finally {
      await reg.shutdown()
    }
  })

  test('requesting the same resident model again neither stops nor restarts', async () => {
    const { reg, runLog, stopLog } = sttSwitchRegistry()
    try {
      await reg.start('whisper-like', 'small')
      await reg.start('whisper-like', 'small')
      expect(runLog).toHaveLength(1)
      expect(stopLog).toHaveLength(0)
    } finally {
      await reg.shutdown()
    }
  })

  test('a switch while a request is in flight is refused with EngineBusyError and never restarts', async () => {
    const { reg, lifecycle, runLog, stopLog } = sttSwitchRegistry()
    try {
      const started = await reg.start('whisper-like', 'small')
      expect(started.state).toBe('running')
      expect(lifecycle.getStatus('whisper-like').private_url).not.toBeNull()
      lifecycle.beginLease('whisper-like')

      await expect(reg.start('whisper-like', 'big')).rejects.toThrow(EngineBusyError)
      expect(runLog).toHaveLength(1)
      expect(stopLog).toHaveLength(0)
    } finally {
      await reg.shutdown()
    }
  })
})

/**
 * Holds the first `docker inspect` that follows the container's own `run`:
 * the status probe `start` ends with, which is the window a caller's lease
 * has not been taken in yet.
 */
function holdingProbe(reached: () => void, held: Promise<void>): (base: Exec) => Exec {
  let ran = false
  let holding = false
  return (base) => async (args) => {
    if (args[0] === 'run') {
      ran = true
    }
    if (ran && !holding && args[0] === 'inspect') {
      holding = true
      reached()
      await held
    }
    return base(args)
  }
}

test('a model switch cannot stop a container out from under a start still in flight', async () => {
  const atProbe = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const { reg, runLog, stopLog } = sttSwitchRegistry(holdingProbe(atProbe.resolve, release.promise))
  try {
    const first = reg.start('whisper-like', 'small')
    await atProbe.promise

    // The first start has its container up and is inside its closing probe;
    // its caller takes a lease only once that returns.
    await expect(reg.start('whisper-like', 'big')).rejects.toThrow(EngineBusyError)
    release.resolve()
    await first

    expect(runLog).toHaveLength(1)
    expect(stopLog).toHaveLength(0)
  } finally {
    release.resolve()
    await reg.shutdown()
  }
})

test('a model switch one microtask after a leased start resolves finds the lease already held', async () => {
  const { reg, runLog, stopLog } = sttSwitchRegistry()
  try {
    // `startsInFlight` does not cover the engine here -- `start` has already
    // returned -- so the only thing standing between the container and a
    // competing switch is a lease the start itself took.
    const started = await reg.start('whisper-like', 'small', { lease: true })
    expect(started.active_leases).toBe(1)

    await expect(reg.start('whisper-like', 'big')).rejects.toThrow(EngineBusyError)
    expect(runLog).toHaveLength(1)
    expect(stopLog).toHaveLength(0)
  } finally {
    await reg.shutdown()
  }
})

// A running container keeps the shape it was started with until it next
// starts, so an operator who edits config and reloads sees no effect and
// nothing tells them why. HUMANS.md has a whole troubleshoot row for it. The
// engine row is where that answer belongs.
describe('a running engine whose config generation has been replaced', () => {
  /** The same comfy engine with one launch-affecting value changed. */
  function comfyConfigWith(readyTimeoutS: number): Config {
    return config({
      engines: [engine({ id: 'comfy', idle_stop_seconds: 9999, ready_timeout_s: readyTimeoutS })],
    })
  }

  test('says so, and names the call that resolves it', async () => {
    await withComfyRegistry(
      {
        exec: comfyExec(),
        cfg: comfyConfigWith(5),
        queueFetch: () => Promise.resolve(BUSY_QUEUE),
        comfyPollIntervalMs: 10_000,
      },
      async (reg) => {
        const started = await reg.start('comfy')
        expect(started.state).toBe('running')
        // Nothing has changed yet, so nothing is superseded.
        expect(reg.get('comfy')?.superseded).toBeUndefined()

        reg.reload(comfyConfigWith(6))

        const after = reg.get('comfy')
        expect(after?.state).toBe('running')
        // The remedy, not a boolean: stopping it is what makes the next call
        // start it on the config now in force.
        expect(after?.superseded).toContain('/engined/v1/engines/comfy/stop')
      },
    )
  })

  test('a reload that changes nothing about this engine leaves it alone', async () => {
    await withComfyRegistry(
      {
        exec: comfyExec(),
        cfg: comfyConfigWith(5),
        queueFetch: () => Promise.resolve(BUSY_QUEUE),
        comfyPollIntervalMs: 10_000,
      },
      async (reg) => {
        await reg.start('comfy')
        // An equal config is a new object every time; comparing identity
        // rather than shape would report every reload as a supersession.
        reg.reload(comfyConfigWith(5))
        expect(reg.get('comfy')?.superseded).toBeUndefined()
      },
    )
  })

  test('an engine that is not running reports none: it reads current config at its next start', async () => {
    await withComfyRegistry(
      {
        exec: comfyExec(),
        cfg: comfyConfigWith(5),
        queueFetch: () => Promise.resolve(BUSY_QUEUE),
        comfyPollIntervalMs: 10_000,
      },
      (reg) => {
        reg.reload(comfyConfigWith(6))
        const never = reg.get('comfy')
        expect(never?.state).not.toBe('running')
        expect(never?.superseded).toBeUndefined()
      },
    )
  })
})
