/**
 * `POST /openai/v1/images/generations`: the OpenAI-shaped image verb over a
 * comfy engine. The container is a stand-in dependency, injected through
 * `comfyHttpClient` exactly as the mediated proxy's own suite does — nothing
 * here reaches a real ComfyUI.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildComfySpec } from './comfy.ts'
import { redirectStateHome } from './enginesFixtures.ts'
import type { HttpClient } from './http.ts'
import { fillWorkflow } from './images.ts'
import { createDoor } from './main.ts'
import {
  BUNX,
  buildExec,
  collectLines,
  config,
  ENGINES_ROOT,
  engine,
  makeTestRoot,
  route,
  writeEngineSpec,
} from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-images-')
let restoreStateHome: (() => void) | undefined
afterAll(() => restoreStateHome?.())
const IMAGES_PATH = '/openai/v1/images/generations'
const EDITS_PATH = '/openai/v1/images/edits'
const COMFY_CONTAINER_PORT = 8188

const COMFY_SPEC = `
kind = "comfy"
upstream = "self"
image = "engined/fakecomfy:local"
obtain = "build"
serves = ["/openai/v1/images/generations", "/openai/v1/images/edits"]
command = []
images_workflow = "{spec_dir}/text-to-image.json"
images_edit_workflow = "{spec_dir}/image-to-image.json"

[ready]
path = "/queue"
status = 200
`

/**
 * A `${name}` placeholder, built rather than written: a workflow graph carries
 * comfy's substitution syntax, not TypeScript's, and only `fillWorkflow`
 * expands it.
 */
const ph = (name: string) => `$\{${name}}`

/** A miniature graph with one of every placeholder kind the real one uses. */
const WORKFLOW = {
  _comment: ['prose comfy would reject as a node'],
  '1': { class_type: 'UNETLoader', inputs: { unet_name: ph('unet') } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: ph('prompt'), clip: ['1', 0] } },
  '3': {
    class_type: 'EmptySD3LatentImage',
    inputs: { width: ph('width'), height: ph('height'), batch_size: ph('batch') },
  },
  '4': {
    class_type: 'KSampler',
    inputs: {
      latent_image: ['3', 0],
      seed: ph('seed'),
      steps: ph('steps'),
      cfg: ph('cfg'),
      sampler_name: ph('sampler'),
      scheduler: ph('scheduler'),
    },
  },
  '5': { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: 'engined_images' } },
}

/** The edit graph's own shape: a loaded image encoded into the starting latent, and a denoise the sampler reads. */
const EDIT_WORKFLOW = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: ph('unet') } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: ph('prompt'), clip: ['1', 0] } },
  '6': { class_type: 'LoadImage', inputs: { image: ph('image') } },
  '7': { class_type: 'VAEEncode', inputs: { pixels: ['6', 0] } },
  '8': {
    class_type: 'KSampler',
    inputs: {
      latent_image: ['7', 0],
      seed: ph('seed'),
      steps: ph('steps'),
      cfg: ph('cfg'),
      sampler_name: ph('sampler'),
      scheduler: ph('scheduler'),
      denoise: ph('denoise'),
    },
  },
  '5': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'engined_edits' } },
}

const CHECKPOINTS = {
  unet: 'Chroma1-HD.safetensors',
  clip: 't5xxl_fp16.safetensors',
  clip_type: 'chroma',
  vae: 'ae.safetensors',
}

/** A one-pixel PNG, so the base64 in the answer is real bytes the door actually fetched. */
const PIXEL = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

async function imagesDoor(
  comfyHttpClient: HttpClient,
  routeArgs: Record<string, unknown> = CHECKPOINTS,
  opts: { write?: (line: string) => void; chatTimeoutSeconds?: number } = {},
) {
  restoreStateHome?.()
  restoreStateHome = redirectStateHome(TEST_ROOT)
  const root = mkdtempSync(join(TEST_ROOT, 'door-'))
  writeEngineSpec(root, 'comfy', COMFY_SPEC)
  mkdirSync(join(root, 'comfy'), { recursive: true })
  writeFileSync(join(root, 'comfy', 'text-to-image.json'), JSON.stringify(WORKFLOW))
  writeFileSync(join(root, 'comfy', 'image-to-image.json'), JSON.stringify(EDIT_WORKFLOW))
  const cfg = config({
    engines: [engine({ id: 'comfy', models_dir: '/data/comfy', idle_stop_seconds: 9999 })],
    routes: [route({ engine: 'comfy', model: undefined, upstream: 'local', args: routeArgs })],
    ...(opts.chatTimeoutSeconds === undefined
      ? {}
      : { chat_timeout_seconds: opts.chatTimeoutSeconds }),
  })
  const door = createDoor(
    cfg,
    {
      enginesRoot: root,
      bunx: BUNX,
      exec: buildExec({ port: 41_100, containerPort: COMFY_CONTAINER_PORT }),
      probe: () => Promise.resolve({ status: 200 }),
    },
    { comfyHttpClient, write: opts.write },
  )
  await door.registry.start('comfy')
  return door
}

/** A container that renders instantly: idle queue, one prompt id, a finished history, and a pixel for /view. */
function rendersInstantly(submitted: string[] = [], uploads: FormData[] = []) {
  const client: HttpClient = (url, init) => {
    const target = String(url)
    if (target.includes('/upload/image')) {
      uploads.push(init?.body as FormData)
      return Promise.resolve(
        Response.json({ name: 'engined_edit_input', subfolder: '', type: 'input' }),
      )
    }
    if (target.includes('/queue') && init?.method !== 'POST') {
      return Promise.resolve(Response.json({ queue_running: [], queue_pending: [] }))
    }
    if (target.includes('/prompt')) {
      submitted.push(String(init?.body ?? ''))
      return Promise.resolve(Response.json({ prompt_id: `job-${submitted.length}` }))
    }
    if (target.includes('/history/')) {
      const id = target.split('/history/')[1] as string
      return Promise.resolve(
        Response.json({ [id]: { outputs: { '5': { images: [{ filename: `${id}.png` }] } } } }),
      )
    }
    return Promise.resolve(new Response(PIXEL, { headers: { 'content-type': 'image/png' } }))
  }
  return client
}

function generate(door: Awaited<ReturnType<typeof imagesDoor>>, body: Record<string, unknown>) {
  return door.fetch(
    new Request(`http://engined${IMAGES_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

describe('the graph is filled, not templated', () => {
  test('a placeholder keeps the type of what replaces it, and prose is not sent as a node', () => {
    const filled = fillWorkflow(WORKFLOW, {
      ...CHECKPOINTS,
      prompt: 'a red cube',
      width: 512,
      height: 768,
      batch: 1,
      seed: 7,
      steps: 20,
      cfg: 4.0,
      sampler: 'euler',
      scheduler: 'simple',
      // A node id that is absent is `undefined`, not a node: these graphs are
      // parsed data, so every lookup below is a lookup that can miss.
    }) as Record<string, { inputs: Record<string, unknown> } | undefined>

    // A number substituted into JSON as a string is the whole reason this
    // walks the parsed object instead of the text: comfy rejects "512".
    expect(filled['3']?.inputs.width).toBe(512)
    expect(filled['3']?.inputs.height).toBe(768)
    expect(filled['1']?.inputs.unet_name).toBe('Chroma1-HD.safetensors')
    expect(filled['2']?.inputs.text).toBe('a red cube')
    // Node wiring is a tuple of [nodeId, slot] and must survive untouched.
    expect(filled['2']?.inputs.clip).toEqual(['1', 0])
    expect(filled._comment).toBeUndefined()
  })

  test('a placeholder the door does not supply is refused, not sent', () => {
    expect(() => fillWorkflow({ a: ph('nonesuch') }, {})).toThrow('nonesuch')
  })
})

describe('POST /openai/v1/images/generations', () => {
  test('renders and answers in the OpenAI envelope, with the image the door actually fetched', async () => {
    const submitted: string[] = []
    const door = await imagesDoor(rendersInstantly(submitted))
    const res = await generate(door, {
      model: '@/comfy/local',
      prompt: 'a red cube',
      size: '512x512',
    })
    const body = (await res.json()) as { created: number; data: { b64_json: string }[] }

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.b64_json).toBe(Buffer.from(PIXEL).toString('base64'))
    expect(typeof body.created).toBe('number')

    // The prompt reached the container inside comfy's own envelope, with the
    // caller's text and size in it.
    const sent = JSON.parse(submitted[0] as string) as {
      prompt: Record<string, { inputs: Record<string, unknown> } | undefined>
    }
    expect(sent.prompt['2']?.inputs.text).toBe('a red cube')
    expect(sent.prompt['3']?.inputs.width).toBe(512)
  })

  test('n images are n renders, each with its own seed', async () => {
    const submitted: string[] = []
    const door = await imagesDoor(rendersInstantly(submitted))
    const res = await generate(door, { model: '@/comfy/local', prompt: 'a red cube', n: 3 })
    const body = (await res.json()) as { data: unknown[] }

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(3)
    expect(submitted).toHaveLength(3)
    // Same prompt, different seeds: three identical images would not be three
    // images.
    const seeds = submitted.map(
      (s) =>
        (JSON.parse(s) as { prompt: Record<string, { inputs: { seed?: number } } | undefined> })
          .prompt['4']?.inputs.seed,
    )
    expect(new Set(seeds).size).toBe(3)
  })

  test('an empty prompt, a bad size and an out-of-range n each name themselves', async () => {
    const door = await imagesDoor(rendersInstantly())
    const noPrompt = await generate(door, { model: '@/comfy/local' })
    const badSize = await generate(door, { model: '@/comfy/local', prompt: 'x', size: 'big' })
    const badN = await generate(door, { model: '@/comfy/local', prompt: 'x', n: 0 })

    expect(noPrompt.status).toBe(400)
    expect(await noPrompt.text()).toContain('prompt')
    expect(badSize.status).toBe(400)
    expect(await badSize.text()).toContain('size')
    expect(badN.status).toBe(400)
    expect(await badN.text()).toContain('n')
  })

  // The checkpoints are the one install-specific half of the render. Left out,
  // comfy would load nothing and answer with a node error naming neither the
  // config nor the missing key.
  test('a route missing its checkpoint args is refused, naming which are missing', async () => {
    const door = await imagesDoor(rendersInstantly(), { unet: 'Chroma1-HD.safetensors' })
    const res = await generate(door, { model: '@/comfy/local', prompt: 'a red cube' })
    const text = await res.text()

    expect(res.status).toBe(400)
    expect(text).toContain('clip')
    expect(text).toContain('vae')
    expect(text).not.toContain('missing unet')
  })

  test("a chain is refused: a second engine's render is a different image, not a retry", async () => {
    const door = await imagesDoor(rendersInstantly())
    const res = await door.fetch(
      new Request(`http://engined${IMAGES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'chain-x', prompt: 'a red cube' }),
      }),
    )
    // Unknown rather than dispatched: this config declares no chain, and the
    // point is that the verb never walks one.
    expect(res.status).toBe(400)
  })
})

// The fixture above is not the artifact that ships. It said `images_workflow`
// before its `[ready]` table and the real spec said it after, where TOML reads
// a bare key as belonging to the table above it -- so the shipped engine
// parsed as `ready.images_workflow` and the verb reported it had no graph at
// all, with every test here still green.
describe('the shipped comfy engine', () => {
  test('resolves an images_workflow that exists, and the graph names only placeholders the door fills', () => {
    const spec = buildComfySpec(engine({ id: 'comfy', models_dir: '/unused' }), {
      enginesRoot: join(import.meta.dir, '..', 'engines'),
      bunx: BUNX,
    })
    expect(spec.images_workflow).toBeDefined()
    expect(existsSync(spec.images_workflow as string)).toBe(true)

    // Every `${name}` the shipped graph carries has to be one the door
    // supplies, or the render throws at request time instead of here.
    const graph = JSON.parse(readFileSync(spec.images_workflow as string, 'utf8')) as unknown
    const supplied = {
      unet: 'u',
      clip: 'c',
      clip_type: 't',
      vae: 'v',
      prompt: 'p',
      negative: '',
      width: 1,
      height: 1,
      batch: 1,
      seed: 1,
      steps: 1,
      cfg: 1,
      sampler: 'euler',
      scheduler: 'simple',
    }
    expect(() => fillWorkflow(graph, supplied)).not.toThrow()
  })
})

interface ProvenanceLine {
  attempts: { engine: string; ok: boolean; failure?: string }[]
  engine_used: string | null
  upstream_used: string | null
}

/** The one line the call is entitled to, parsed back out of what the door wrote. */
function lastRecord(lines: string[]): ProvenanceLine {
  return JSON.parse(lines.at(-1) as string) as ProvenanceLine
}

describe('the one line this call is entitled to', () => {
  test('a render answered is recorded as a success, naming the engine that answered', async () => {
    const { lines, write } = collectLines()
    const door = await imagesDoor(rendersInstantly(), CHECKPOINTS, {
      write,
    })
    const res = await generate(door, { model: '@/comfy/local', prompt: 'a red cube' })
    const record = lastRecord(lines)

    expect(res.status).toBe(200)
    expect(record.attempts[0]?.ok).toBe(true)
    expect(record.attempts[0]?.failure).toBeUndefined()
    expect(record.engine_used).toBe('comfy')
  })

  // journald is the whole observability surface for this verb, and a failed
  // render indistinguishable from a rendered one is no surface at all.
  test('a container that refuses the prompt is recorded as a failure, in its own words', async () => {
    const { lines, write } = collectLines()
    const refusesThePrompt: HttpClient = (url) =>
      Promise.resolve(
        String(url).includes('/prompt')
          ? Response.json({ error: 'node 4 has no input named sampler' }, { status: 400 })
          : Response.json({ queue_running: [], queue_pending: [] }),
      )
    const door = await imagesDoor(refusesThePrompt, CHECKPOINTS, {
      write,
    })
    const res = await generate(door, { model: '@/comfy/local', prompt: 'a red cube' })
    const record = lastRecord(lines)

    expect(res.status).toBe(400)
    expect(record.attempts[0]?.ok).toBe(false)
    expect(record.attempts[0]?.failure).toContain('no input named sampler')
    // Nothing answered, so nothing is named as having answered.
    expect(record.engine_used).toBeNull()
    expect(record.upstream_used).toBeNull()
  })

  test('an image comfy will not serve is a failure, not an empty success', async () => {
    const { lines, write } = collectLines()
    const rendersThenHides: HttpClient = (url, init) =>
      String(url).includes('/view')
        ? Promise.resolve(new Response('gone', { status: 404 }))
        : rendersInstantly()(url, init)
    const door = await imagesDoor(rendersThenHides, CHECKPOINTS, {
      write,
    })
    const res = await generate(door, { model: '@/comfy/local', prompt: 'a red cube' })
    const record = lastRecord(lines)

    expect(res.status).toBe(502)
    expect(record.attempts[0]?.ok).toBe(false)
    expect(record.attempts[0]?.failure).toContain('would not serve it')
  })
})

// The deadline is computed before the queue drain is waited through, so a
// budget already spent by the time the prompt is submitted must still buy one
// look at /history -- the render it asks about may have finished.
describe('collect asks before it gives up', () => {
  test('a deadline already passed is one probe, not none', async () => {
    const door = await imagesDoor(rendersInstantly(), CHECKPOINTS, { chatTimeoutSeconds: 0 })
    const res = await generate(door, { model: '@/comfy/local', prompt: 'a red cube' })
    const body = (await res.json()) as { data: { b64_json: string }[] }

    expect(res.status).toBe(200)
    expect(body.data[0]?.b64_json).toBe(Buffer.from(PIXEL).toString('base64'))
  })
})

/** One multipart edit request; `fields` overrides or adds to the defaults. */
function edit(
  door: Awaited<ReturnType<typeof imagesDoor>>,
  fields: Record<string, string | Blob> = {},
  { omitImage = false } = {},
) {
  const form = new FormData()
  if (!omitImage) {
    form.append('image', new Blob([PIXEL], { type: 'image/png' }), 'in.png')
  }
  form.append('model', '@/comfy/local')
  form.append('prompt', 'make it blue')
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value)
  }
  return door.fetch(new Request(`http://engined${EDITS_PATH}`, { method: 'POST', body: form }))
}

describe('POST /openai/v1/images/edits', () => {
  test('uploads the image, names it in the graph, and answers in the OpenAI envelope', async () => {
    const submitted: string[] = []
    const uploads: FormData[] = []
    const door = await imagesDoor(rendersInstantly(submitted, uploads))

    const res = await edit(door, { seed: '7', denoise: '0.4' })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: [{ b64_json: expect.any(String) }] })
    // The caller's bytes went to the container's own input directory: a path
    // from the caller would name nothing a LoadImage node can reach.
    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.get('overwrite')).toBe('true')
    const graph = JSON.parse(submitted[0] as string).prompt
    // The name comfy answered with, not the caller's filename.
    expect(graph['6'].inputs.image).toBe('engined_edit_input')
    expect(graph['8'].inputs.denoise).toBe(0.4)
    expect(graph['8'].inputs.seed).toBe(7)
    expect(graph['2'].inputs.text).toBe('make it blue')
  })

  // The graph is the whole difference between the two verbs, so rendering the
  // text-to-image one here would silently ignore the image that was uploaded.
  test('renders the edit graph, not the generation one', async () => {
    const submitted: string[] = []
    const door = await imagesDoor(rendersInstantly(submitted, []))

    await edit(door)

    const graph = JSON.parse(submitted[0] as string).prompt
    expect(graph['6'].class_type).toBe('LoadImage')
    expect(graph['3']).toBeUndefined()
  })

  test('a form with no image part is refused before anything is started', async () => {
    const submitted: string[] = []
    const door = await imagesDoor(rendersInstantly(submitted, []))

    const res = await edit(door, {}, { omitImage: true })

    expect(res.status).toBe(400)
    expect(submitted).toHaveLength(0)
  })

  // 1.0 keeps none of the input, which is what /images/generations already is,
  // and 0 answers with the image it was handed.
  test.each(['0', '1.5', '-0.2'])('denoise %p is refused', async (denoise) => {
    const door = await imagesDoor(rendersInstantly())

    expect((await edit(door, { denoise })).status).toBe(400)
  })

  test('a non-numeric denoise is a 400, never a NaN sent to the sampler', async () => {
    const submitted: string[] = []
    const door = await imagesDoor(rendersInstantly(submitted, []))

    const res = await edit(door, { denoise: 'quite a lot' })

    expect(res.status).toBe(400)
    expect(submitted).toHaveLength(0)
  })

  test("an unsupplied denoise takes the door's default rather than failing the fill", async () => {
    const submitted: string[] = []
    const door = await imagesDoor(rendersInstantly(submitted, []))

    await edit(door)

    expect(JSON.parse(submitted[0] as string).prompt['8'].inputs.denoise).toBe(0.9)
  })

  test('an oversized image is 413 before the form is read', async () => {
    const submitted: string[] = []
    const door = await imagesDoor(rendersInstantly(submitted, []))

    const res = await door.fetch(
      new Request(`http://engined${EDITS_PATH}`, {
        method: 'POST',
        headers: { 'content-length': String(33_554_433) },
        body: 'x',
      }),
    )

    expect(res.status).toBe(413)
    expect(submitted).toHaveLength(0)
  })

  test('an upload comfy refuses is a 502 naming it, and no prompt is submitted', async () => {
    const submitted: string[] = []
    const client: HttpClient = (url, init) => {
      const target = String(url)
      if (target.includes('/upload/image')) {
        return Promise.resolve(new Response('no space left', { status: 507 }))
      }
      return rendersInstantly(submitted, [])(url, init)
    }
    const door = await imagesDoor(client)

    const res = await edit(door)

    expect(res.status).toBe(502)
    expect(await res.text()).toContain('no space left')
    expect(submitted).toHaveLength(0)
  })
})

/**
 * The graphs that actually ship, against the values the door actually
 * supplies. A placeholder the door does not fill throws in `fillWorkflow`,
 * which without this is only discovered by a render on a real GPU -- and a
 * graph edit is exactly the change most likely to introduce one.
 */
describe('the shipped comfy graphs', () => {
  const Shared = {
    ...CHECKPOINTS,
    prompt: 'a red cube',
    negative: '',
    seed: 7,
    steps: 20,
    cfg: 4.0,
    sampler: 'euler',
    scheduler: 'simple',
  }

  test.each([
    ['text-to-image.json', { ...Shared, width: 1024, height: 1024, batch: 1 }],
    ['image-to-image.json', { ...Shared, image: 'engined_edit_input', denoise: 0.9 }],
  ])('%s parses and every placeholder in it is one the door supplies', (file, values) => {
    const graph = JSON.parse(readFileSync(join(ENGINES_ROOT, 'comfy', file), 'utf8')) as unknown
    const filled = fillWorkflow(graph, values) as Record<string, unknown>
    expect(filled._comment).toBeUndefined()
    // Every node kept its wiring: a filled graph comfy can act on, not an
    // object that merely stopped throwing.
    expect(Object.keys(filled).length).toBeGreaterThan(0)
    for (const node of Object.values(filled)) {
      expect(node).toHaveProperty('class_type')
    }
  })
})
