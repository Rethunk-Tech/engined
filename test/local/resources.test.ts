import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DockerLifecycle, dockerExec } from '../../src/docker.ts'
import { LlamaRouter } from '../../src/llama.ts'
import { engine } from '../../src/test-support.ts'
import type { EngineEntry } from '../../src/types.ts'
import {
  BUNX,
  ENGINES_ROOT,
  imageBuilt,
  LOCAL,
  requireMemoryFor,
  specImage,
  TEST_NAME_PREFIX,
} from './exclusive.ts'
import { type ChatRoute, isChatRoute, loadLocalConfig, skipTitle } from './fixtures.ts'

/**
 * Proves `resources.ts` against a real loaded engine rather than a recorded
 * fdinfo string.
 *
 * The unit tier already covers the parser's branching, but only against
 * fixtures -- which cannot catch the thing the parser was written for: the
 * kernel changing what it reports. Both of its rules came from measurement on
 * this box, and both are asserted here against the machine rather than against
 * the parser's own output:
 *
 *  - A loaded model lands in GTT, which the cgroup does not account for, so
 *    `memory_bytes` alone understates a busy engine by orders of magnitude.
 *
 * The independent oracle is amdgpu's own `mem_info_` counters under
 * /sys/class/drm, which is what the original measurement reconciled against.
 * Both sides sum VRAM and GTT, so the reconciliation holds wherever the model
 * actually lands; on a machine with no `mem_info_` at all the whole block
 * skips. Note the pool is architecture-dependent, though: on this APU the
 * model sits in GTT and VRAM is near-empty, so a regression that dropped GTT
 * reddens here and would not on a discrete card holding the same model in
 * VRAM.
 *
 * What this cannot cover: `parseGraphicsBytes` also folds per DRM client
 * because one client repeats its whole total once per open fd. That was
 * seen on the HOST, where a desktop process held dozens. Inside an
 * engine container the census is one fdinfo entry and one client id, so the
 * fold is a no-op here and no container-based test can catch its removal.
 * Only the unit tier's recorded multi-fd fixture covers that half.
 */
const READY_TIMEOUT_S = 240
const IDLE_STOP_SECONDS = 900
const POLL_INTERVAL_MS = 500
const TEST_TIMEOUT_MS = 300_000
const GIB = 1024 ** 3

/**
 * The floor a real GGUF must clear. Deliberately far below any model this
 * engine serves: the assertion is "graphics memory was actually accounted
 * for", not a pin on which model happens to be configured.
 */
const MIN_LOADED_GRAPHICS_BYTES = GIB

/**
 * How far the engine's reading may sit from the device's own delta. Generous
 * against the observed agreement so unrelated GPU activity
 * on the box cannot redden this, while still an order of magnitude tighter
 * than any per-fd inflation.
 */
const RECONCILE_TOLERANCE = GIB

const EMPTY_ENGINE: EngineEntry = engine({ id: 'llama' })

interface Fixture {
  engine: EngineEntry
  chat?: ChatRoute
  image?: string
  error?: string
}

function loadFixture(): Fixture {
  const { config, error } = loadLocalConfig()
  if (!config) {
    return { engine: EMPTY_ENGINE, error }
  }
  const llamaEngine = config.engines.find((e) => e.id === 'llama')
  if (!llamaEngine) {
    return { engine: EMPTY_ENGINE, error: 'config.example.toml has no llama engine' }
  }
  return {
    engine: llamaEngine,
    chat: config.routes.find(isChatRoute),
    image: specImage(llamaEngine),
  }
}

/**
 * amdgpu's own accounting for the whole device, summed the way the engine's
 * own reading is: VRAM plus GTT, because on this APU either alone is
 * misleading. System-wide, so it bounds the engine rather than equalling it.
 */
function kernelGraphicsBytes(): number | undefined {
  for (const card of ['card0', 'card1', 'card2']) {
    const base = `/sys/class/drm/${card}/device`
    try {
      const vram = Number(readFileSync(`${base}/mem_info_vram_used`, 'utf8').trim())
      const gtt = Number(readFileSync(`${base}/mem_info_gtt_used`, 'utf8').trim())
      if (Number.isFinite(vram) && Number.isFinite(gtt)) {
        return vram + gtt
      }
    } catch {
      // Not this card, or no amdgpu: try the next.
    }
  }
  return undefined
}

const FIXTURE = loadFixture()
const HAVE_IMAGE = LOCAL && FIXTURE.image !== undefined && imageBuilt(FIXTURE.image)
const HAVE_KERNEL_COUNTERS = LOCAL && kernelGraphicsBytes() !== undefined
const READY = LOCAL && HAVE_IMAGE && FIXTURE.chat !== undefined && HAVE_KERNEL_COUNTERS

if (READY) {
  await requireMemoryFor('llama')
}

function skipReason(): string {
  if (FIXTURE.error !== undefined) {
    return `config.example.toml did not load cleanly: ${FIXTURE.error}`
  }
  if (!HAVE_IMAGE) {
    return `${FIXTURE.image ?? "llama's image"} is not built -- see engines/llama`
  }
  if (FIXTURE.chat === undefined) {
    return 'config.example.toml has no llama model in the chat role'
  }
  return 'no amdgpu mem_info counters under /sys/class/drm -- nothing to reconcile against'
}

/** Drives one real completion, which is what makes the GGUF resident for the reading below. */
async function loadChatModel(lifecycle: DockerLifecycle, chat: ChatRoute): Promise<void> {
  const router = new LlamaRouter(FIXTURE.engine, [chat], lifecycle, {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    streamStallSeconds: () => 60,
    idleStopSeconds: IDLE_STOP_SECONDS,
    readyTimeoutS: READY_TIMEOUT_S,
    presetHostPath: join(import.meta.dir, '.scratch-preset-resources.ini'),
    pollIntervalMs: POLL_INTERVAL_MS,
  })
  const { response } = await router.proxy(chat, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: chat.model,
      messages: [{ role: 'user', content: 'Reply with the single word: hi' }],
      max_tokens: 4,
    }),
  })
  if (response.status !== 200) {
    throw new Error(`chat completion failed with HTTP ${response.status}`)
  }
  await response.text()
}

describe.skipIf(!READY)(skipTitle('engine resources (local)', READY, skipReason()), () => {
  const lifecycle = new DockerLifecycle(dockerExec, undefined, TEST_NAME_PREFIX)

  afterAll(async () => {
    await lifecycle.removeEngine(FIXTURE.engine.id)
  })

  test(
    'a resident GGUF is accounted for in graphics memory, which the cgroup does not see',
    async () => {
      const { chat } = FIXTURE
      if (chat === undefined) {
        throw new Error('fixture has no chat model -- READY should have been false')
      }
      const kernelBefore = kernelGraphicsBytes() ?? 0
      await loadChatModel(lifecycle, chat)

      const read = await lifecycle.resources(FIXTURE.engine.id)
      if (!read.ok) {
        throw new Error(`resources failed: ${read.error}`)
      }
      const { memory_bytes, graphics_bytes } = read.resources
      const kernelAfter = kernelGraphicsBytes() ?? 0

      // The container has /dev/dri, so neither field may be the absent case.
      expect(graphics_bytes).not.toBeNull()
      expect(memory_bytes).not.toBeNull()
      const graphics = graphics_bytes ?? 0
      const cgroup = memory_bytes ?? 0

      expect(graphics).toBeGreaterThan(MIN_LOADED_GRAPHICS_BYTES)

      // The whole reason both are summed: a consumer reading only the cgroup
      // sees a fraction of what the engine actually holds.
      expect(cgroup).toBeLessThan(graphics)

      // The real reconciliation, against the kernel rather than against
      // ourselves: what this engine reports holding must equal how much amdgpu
      // says the whole device gained by loading it. A wrong field, a KiB/byte slip, GTT dropped, or a probe
      // that silently returned nothing all stop matching that delta.
      expect(Math.abs(graphics - (kernelAfter - kernelBefore))).toBeLessThan(RECONCILE_TOLERANCE)
    },
    TEST_TIMEOUT_MS,
  )
})
