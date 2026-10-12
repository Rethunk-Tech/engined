import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { FatalError } from './errors/fatal.ts'
import { runProbes } from './probe.ts'
import {
  digitsPng,
  readProbeText,
  splitColorPng,
  visionReadVerdict,
  visionRequestBody,
  visionVerdict,
} from './probeImage.ts'
import { CONTRACT } from './responses.ts'
import { OPENAI_MODELS_PATH } from './routeServes.ts'
import { makeTestRoot } from './test-support.ts'
import { ENGINED_ENGINES_PATH } from './usage.ts'

/** The ExecStart flag, read once: a regex rebuilt per call is a lint warning and a wasted compile. */
const RX_EXEC_START_FLAG = /^ExecStart=.*?(--[a-z-]+)\s*$/m

/** The probe's own text shape: exactly eight digits, nothing round them. */
const RX_PROBE_DIGITS = /^\d{8}$/

type DoorHandler = (init?: RequestInit) => Response | Promise<Response>

/** A door whose path handlers default to an empty engines list, `rows` as the model menu, and a chat `reply`. */
function fakeDoor(
  rows: unknown[],
  reply = '',
  overrides: {
    menuStatus?: number
    engines?: DoorHandler
    models?: DoorHandler
    other?: DoorHandler
  } = {},
): typeof fetch {
  const { menuStatus = 200, engines, models, other } = overrides
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/engined/v1/engines')) {
      return Promise.resolve(
        engines ? engines(init) : Response.json({ contract: CONTRACT, engines: [] }),
      )
    }
    if (url.endsWith('/openai/v1/models')) {
      return Promise.resolve(
        models
          ? models(init)
          : new Response(JSON.stringify({ object: 'list', data: rows }), { status: menuStatus }),
      )
    }
    return Promise.resolve(
      other ? other(init) : Response.json({ choices: [{ message: { content: reply } }] }),
    )
  }) as typeof fetch
}

function pngHeader(png: Uint8Array): DataView {
  expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  return new DataView(png.buffer, png.byteOffset, png.byteLength)
}

function capturingDoor(rows: unknown[], reply = ''): { client: typeof fetch; bodies: string[] } {
  const bodies: string[] = []
  const client = fakeDoor(rows, reply, {
    other: (init) => {
      bodies.push(String(init?.body ?? ''))
      return Response.json({ choices: [{ message: { content: reply } }] })
    },
  })
  return { client, bodies }
}

const VISION_ROW = { id: '@/llama/see', role: 'vision', vision: 'describe', state: 'installed' }

test('the probe sends a real PNG: signature, and IHDR carrying the size it was asked for', () => {
  const png = splitColorPng(64, [220, 20, 20], [20, 20, 220])
  // IHDR's width and height sit at bytes 16 and 20: 8 signature + 4 length +
  // 4 type. A PNG whose header disagreed with its pixel data would decode to
  // nothing and the whole probe would be testing a decode failure.
  const view = pngHeader(png)
  expect(view.getUint32(16)).toBe(64)
  expect(view.getUint32(20)).toBe(64)
  expect(new TextDecoder().decode(png.slice(12, 16))).toBe('IHDR')
})

test('the verdict needs both halves and their order, not one colour', () => {
  expect(visionVerdict('Red, blue.').ok).toBe(true)
  // The defect this exists to catch names plausible colours; naming them
  // backwards is the part guessing cannot get right.
  expect(visionVerdict('Blue, red.').ok).toBe(false)
  expect(visionVerdict('Blue.').ok).toBe(false)
  expect(visionVerdict('A photograph of a cat.').ok).toBe(false)
  expect(visionVerdict('').ok).toBe(false)
  // The prompt must not contain the answer. A model that echoes it would pass
  // without having seen the image, and a green verdict would have proved nothing.
  const asked = visionRequestBody('probe').toLowerCase()
  expect(asked.includes('red')).toBe(false)
  expect(asked.includes('blue')).toBe(false)
  // The detail carries the reply, because a failure nobody can read is a
  // failure nobody acts on.
  expect(visionVerdict('Blue, red.').detail).toContain('Blue, red.')
})

test('the read probe draws the digits it will check for, as a real PNG', () => {
  const png = digitsPng('40718352')
  const view = pngHeader(png)
  // 8 glyphs of 5 cells plus a gap between each, and 2 cells of margin all
  // round, at 14 image pixels per cell.
  expect(view.getUint32(16)).toBe((8 * 6 - 1 + 4) * 14)
  expect(view.getUint32(20)).toBe((7 + 4) * 14)
  // A different string is a different image, or the probe would be sending
  // one picture and checking for another string.
  expect(Buffer.from(digitsPng('11111111')).equals(Buffer.from(png))).toBe(false)
})

test('a fresh digit string every run, so no answer comes from having seen the image', () => {
  const runs = new Set(Array.from({ length: 32 }, () => readProbeText()))
  expect([...runs].every((t) => RX_PROBE_DIGITS.test(t))).toBe(true)
  // Not a distribution test: one repeated string across 32 draws would mean a
  // constant, which is the property that matters here.
  expect(runs.size).toBeGreaterThan(1)
})

test('the read verdict wants the digits, not the wrapper a model puts round them', () => {
  expect(visionReadVerdict('40718352', '40718352').ok).toBe(true)
  // A reader that framed its answer still read the image.
  expect(visionReadVerdict('40718352', 'The digits are 4071 8352.').ok).toBe(true)
  expect(visionReadVerdict('40718352', '40718353').ok).toBe(false)
  expect(visionReadVerdict('40718352', '4071835').ok).toBe(false)
  expect(visionReadVerdict('40718352', 'a photograph of a cat').detail).toContain('40718352')
})

test('a read route is asked to read and a describe route to describe, from the same menu', async () => {
  const rows = [
    VISION_ROW,
    { id: '@/llama/ocr', role: 'vision', vision: 'read', state: 'installed' },
  ]
  // Neither check's right answer, so the assertion below is about which
  // question was asked and not about which reply happened to satisfy it.
  const { client, bodies } = capturingDoor(rows)

  await runProbes('http://door', client)

  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toContain('two vertical halves')
  expect(bodies[1]).toContain('Read the digits')
  expect(bodies[1]).not.toContain('two vertical halves')
})

test('a route with no vision kind gets the describe check, which is what a vision route usually is', async () => {
  const { client, bodies } = capturingDoor([VISION_ROW], 'red blue')

  const report = await runProbes('http://door', client)
  expect(report.ok).toBe(true)
  expect(bodies[0]).toContain('two vertical halves')
})

test('a vision address that answers correctly proves', async () => {
  const report = await runProbes('http://door', fakeDoor([VISION_ROW], 'red then blue'))
  expect(report.ok).toBe(true)
  expect(report.lines).toEqual([{ address: '@/llama/see', ok: true, detail: '"red then blue"' }])
})

test('a vision address that names the halves backwards fails, and the line says which address', async () => {
  const report = await runProbes('http://door', fakeDoor([VISION_ROW], 'blue then red'))
  expect(report.ok).toBe(false)
  expect(report.lines[0]?.address).toBe('@/llama/see')
  expect(report.lines[0]?.detail).toContain('wrong order')
})

test('only vision rows are probed: a chat row serves the same path and is left alone', async () => {
  const rows = [
    { id: '@/llama/ornith', role: 'chat', state: 'installed' },
    { id: '@/llama/embed', role: 'embedding', state: 'installed' },
  ]
  // Every row would fail the verdict if it were sent, so a pass here is proof
  // none of them was.
  const report = await runProbes('http://door', fakeDoor(rows, 'a cat'))
  expect(report.ok).toBe(true)
  expect(report.lines[0]?.detail).toBe('no reachable address to prove')
})

test('an unavailable vision address fails rather than passing unproved', async () => {
  const rows = [{ id: '@/llama/see', role: 'vision', vision: 'describe', state: 'unavailable' }]
  const report = await runProbes('http://door', fakeDoor(rows, 'a cat'))
  expect(report.ok).toBe(false)
  expect(report.lines[0]?.address).toBe('@/llama/see')
  expect(report.lines[0]?.detail).toContain('not checked')
})

// A door
// built before `role` answers with every vision route present and no role on
// any of them, and reading only "is any row vision?" reports a pass it never
// earned. The failure names the install command because that is the fix.
test('a vision address with no declared kind fails rather than being guessed at', async () => {
  const rows = [{ id: '@/llama/see', role: 'vision', state: 'installed' }]
  const report = await runProbes('http://door', fakeDoor(rows, 'red then blue'))
  expect(report.ok).toBe(false)
  expect(report.lines[0]?.detail).toContain('install.sh')
})

// Staleness is read off the door's own contract now, not guessed from
// whether any row carries a `role` -- see the contract test at the end. A
// current door whose routes simply have no roles has nothing to prove, and
// that is a pass.
test('a current door whose rows carry no role has nothing to prove, and says so', async () => {
  const rows = [
    { id: '@/llama/ornith', state: 'installed' },
    { id: '@/llama/vision', state: 'installed' },
  ]
  const report = await runProbes('http://door', fakeDoor(rows, 'red then blue'))
  expect(report.ok).toBe(true)
  expect(report.lines[0]?.detail).toBe('no reachable address to prove')
})

test('every installed vision address is probed, not just the first', async () => {
  const rows = [
    VISION_ROW,
    { id: '@/llama/ocr', role: 'vision', vision: 'describe', state: 'installed' },
  ]
  const report = await runProbes('http://door', fakeDoor(rows, 'blue then red'))
  expect(report.lines.map((l) => l.address)).toEqual(['@/llama/see', '@/llama/ocr'])
  expect(report.ok).toBe(false)
})

test('a door that cannot answer for its own menu fails rather than reporting nothing to prove', async () => {
  const report = await runProbes('http://door', fakeDoor([], '', { menuStatus: 503 }))
  expect(report.ok).toBe(false)
  expect(report.lines[0]?.detail).toContain('503')
})

test('a door that cannot be reached at all fails', async () => {
  const dead = ((input: string | URL | Request) =>
    Promise.reject(new Error(`ECONNREFUSED ${String(input)}`))) as typeof fetch
  const report = await runProbes('http://door', dead)
  expect(report.ok).toBe(false)
  expect(report.lines[0]?.detail).toContain('ECONNREFUSED')
})

// The flag is one fact split across a unit template and an argv check, the
// same shape as RestartPreventExitStatus. Renaming it in one place leaves
// every other test green while the timer silently starts a second daemon.
test("the probe unit's ExecStart names the flag main.ts branches on", () => {
  const here = import.meta.dir
  const unit = readFileSync(join(here, '../scripts/engined-probe.service.in'), 'utf8')
  const main = readFileSync(join(here, 'main.ts'), 'utf8')
  const flag = unit.match(RX_EXEC_START_FLAG)?.[1]
  expect(flag).toBe('--probe')
  expect(main).toContain(`process.argv.includes('${flag}')`)
})

test('--help and -h print usage and exit 0 without starting the door', async () => {
  const main = readFileSync(join(import.meta.dir, 'main.ts'), 'utf8')
  expect(main).toContain("process.argv.includes('--help')")
  expect(main).toContain("process.argv.includes('-h')")
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'main.ts'), '--help'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(code).toBe(0)
  expect(stdout).toContain('Usage:')
  expect(stdout).toContain('--engines --json')
  expect(stdout).toContain('no text listing')
  expect(stderr).toBe('')
})

const RERANK_ROW = { id: '@/llama/rerank', role: 'rerank', state: 'installed' }
/** A transcription route that has NOT declared `translate`: the one that must refuse. */
const ENGLISH_ONLY_ROW = {
  id: '@/whisper/medium.en',
  state: 'installed',
  serves: ['/openai/v1/audio/transcriptions'],
}

/** A door answering the rerank verb with `results` in the order given, best first. */
function fakeRerankDoor(rows: unknown[], order: number[]): typeof fetch {
  return fakeDoor(rows, '', {
    other: () => Response.json({ results: order.map((index) => ({ index, relevance_score: 1 })) }),
  })
}

test('the rerank probe passes when the answering document is ranked first', async () => {
  // Index 1 is the docker document, the only one of the three that answers
  // the query the probe sends.
  const report = await runProbes('http://door', fakeRerankDoor([RERANK_ROW], [1, 2, 0]))

  expect(report.ok).toBe(true)
  expect(report.lines[0]?.address).toBe('@/llama/rerank')
})

// A reranker that has stopped ranking still answers 200 with well-formed
// results, which is exactly why the check is on the order and not the status.
test('the rerank probe fails when an irrelevant document is ranked first', async () => {
  const report = await runProbes('http://door', fakeRerankDoor([RERANK_ROW], [2, 1, 0]))

  expect(report.ok).toBe(false)
  expect(report.lines[0]?.detail).toContain('index 2')
})

test('a reply with no ranked results fails rather than passing on a 200', async () => {
  const noResults = fakeDoor([RERANK_ROW], '', { other: () => Response.json({ results: [] }) })

  const report = await runProbes('http://door', noResults)

  expect(report.ok).toBe(false)
})

/** A door that answers the translations verb with `status`, and the menu with `rows`. */
function fakeTranslateDoor(rows: unknown[], status: number): typeof fetch {
  return fakeDoor(rows, '', {
    other: () => new Response('does not serve /openai/v1/audio/translations', { status }),
  })
}

test('a transcription route that never declared translate must refuse, and passing is the refusal', async () => {
  const report = await runProbes('http://door', fakeTranslateDoor([ENGLISH_ONLY_ROW], 400))

  expect(report.ok).toBe(true)
  expect(report.lines[0]?.detail).toContain('refused')
})

// The failure this whole guard exists for: an English-only model handed the
// translate flag does not error, it transcribes -- so a 200 here is the bug.
test('a route that answers a translate request instead of refusing it fails the probe', async () => {
  const report = await runProbes('http://door', fakeTranslateDoor([ENGLISH_ONLY_ROW], 200))

  expect(report.ok).toBe(false)
  expect(report.lines[0]?.detail).toContain('instead of refusing')
})

// A route that declared it is allowed to answer, so it is not one of the
// routes this guard checks.
test('a route declaring translate is not asked to refuse', async () => {
  const declared = { ...ENGLISH_ONLY_ROW, id: '@/whisper/large-v3-turbo', translate: true }

  const report = await runProbes('http://door', fakeTranslateDoor([declared], 200))

  expect(report.lines).toHaveLength(1)
  expect(report.lines[0]?.detail).toBe('no reachable address to prove')
})

// The signal that replaced guessing from whether any row carried a `role`:
// whisper, tts and comfy routes carry none, so a box serving only those used
// to read as a stale daemon and fail weekly for a defect that was not there.
test('a door on an older contract fails once, naming the fix', async () => {
  const old = fakeDoor([], '', {
    engines: () => Response.json({ contract: CONTRACT - 1, engines: [] }),
    models: () => Response.json({ object: 'list', data: [] }),
  })

  const report = await runProbes('http://door', old)

  expect(report.ok).toBe(false)
  expect(report.lines).toHaveLength(1)
  expect(report.lines[0]?.detail).toContain('install.sh')
})

test('a whisper-only door proves what it can and does not read as stale', async () => {
  const report = await runProbes('http://door', fakeTranslateDoor([ENGLISH_ONLY_ROW], 400))

  expect(report.ok).toBe(true)
})

// The bug this pins: the filter read `state === "installed"`, so every
// address on an engine that was already up reported `running` and was
// skipped. The probe proved nothing exactly when the box was in use.
test('an address on an engine that is already running is still probed', async () => {
  const running = { ...VISION_ROW, state: 'running' }

  const report = await runProbes('http://door', fakeDoor([running], 'red then blue'))

  expect(report.lines[0]?.address).toBe('@/llama/see')
  expect(report.ok).toBe(true)
})

test('an unavailable vision address is not a pass: the nonsense reply was never accepted', async () => {
  const down = { ...VISION_ROW, state: 'unavailable' }

  const report = await runProbes('http://door', fakeDoor([down], 'nonsense'))

  expect(report.ok).toBe(false)
  expect(report.lines).toHaveLength(1)
  expect(report.lines[0]?.detail).toContain('not checked')
})

// The menu has to report `translate` for the refusal check to know which
// routes must refuse. When it did not, the one route allowed to translate
// looked like one that must refuse, and the probe failed on a correct config.
test('a running route that declares translate is not asked to refuse', async () => {
  const declared = {
    id: '@/whisper/large-v3-turbo',
    state: 'running',
    translate: true,
    serves: ['/openai/v1/audio/transcriptions', '/openai/v1/audio/translations'],
  }

  const report = await runProbes('http://door', fakeTranslateDoor([declared], 200))

  expect(report.ok).toBe(true)
  expect(report.lines[0]?.detail).toBe('no reachable address to prove')
})

const FIM_ROW = {
  id: '@/llama/ornith',
  role: 'chat',
  state: 'installed',
  serves: ['/openai/v1/chat/completions', '/openai/v1/completions'],
}

/** A door answering the completions verb with `text` in the OpenAI legacy shape, whatever it was asked. */
function fakeCompletionsDoor(rows: unknown[], text: string): typeof fetch {
  return fakeDoor(rows, '', {
    other: () => Response.json({ choices: [{ text, finish_reason: 'stop' }] }),
  })
}

test('the completions probe passes when the reply carries a non-empty completion', async () => {
  const report = await runProbes('http://door', fakeCompletionsDoor([FIM_ROW], '    return a + b'))

  expect(report.ok).toBe(true)
  expect(report.lines[0]?.address).toBe('@/llama/ornith')
})

test('the completions probe fails when the reply carries no completion text', async () => {
  const report = await runProbes('http://door', fakeCompletionsDoor([FIM_ROW], ''))

  expect(report.ok).toBe(false)
  expect(report.lines[0]?.detail).toBe('the reply carried no completion text')
})

test('only a route serving /openai/v1/completions is probed: a plain chat route is left alone', async () => {
  const chatOnly = { ...FIM_ROW, serves: ['/openai/v1/chat/completions'] }

  const report = await runProbes('http://door', fakeCompletionsDoor([chatOnly], 'unused'))

  expect(report.lines).toHaveLength(1)
  expect(report.lines[0]?.detail).toBe('no reachable address to prove')
})

const PROBE_ROOT = makeTestRoot('engined-probe-cli-')

/** `ok|FAIL <address>: <detail>`. The address contains colons; the separator is colon-space. */
const RX_PROBE_TEXT = /^(ok|FAIL) (.*?): (.*)$/

interface ReportedLine {
  address: string
  ok: boolean
  detail: string
}

function reportedLines(stdout: string): ReportedLine[] {
  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
  return body.split('\n').map((line) => {
    const match = RX_PROBE_TEXT.exec(line)
    if (match === null) {
      throw new Error(`probe text line: ${line}`)
    }
    const [, status, address, detail] = match
    if (status === undefined || address === undefined || detail === undefined) {
      throw new Error(`probe text line: ${line}`)
    }
    return { ok: status === 'ok', address, detail }
  })
}

function configHomeFor(port: number): string {
  const configHome = join(mkdtempSync(join(PROBE_ROOT, 'home-')), 'config')
  mkdirSync(join(configHome, 'engined'), { recursive: true })
  writeFileSync(join(configHome, 'engined', 'config.toml'), `listen_port = ${port}\n`)
  return configHome
}

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'main.ts'), ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => proc.kill(), 10_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

/** A door on an ephemeral port. `menuStatus` is what `GET /openai/v1/models` answers. */
async function withDoor(
  menuStatus: number,
  fn: (port: number) => Promise<void>,
  enginesPayload: Record<string, unknown> = { contract: CONTRACT, engines: [] },
): Promise<void> {
  let hits = 0
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      hits += 1
      const path = new URL(req.url).pathname
      if (path === OPENAI_MODELS_PATH) {
        return menuStatus === 200
          ? Response.json({ object: 'list', data: [] })
          : new Response('unavailable', { status: menuStatus })
      }
      if (path === ENGINED_ENGINES_PATH) {
        return Response.json(enginesPayload)
      }
      return new Response('unhandled', { status: 404 })
    },
  })
  const port = server.port
  try {
    if (port === undefined) {
      throw new Error('the fake door did not bind a port')
    }
    await fn(port)
    expect(hits).toBeGreaterThan(0)
  } finally {
    server.stop(true)
  }
}

test('--probe --json prints the probe report as one JSON document', async () => {
  await withDoor(200, async (port) => {
    const env = { XDG_CONFIG_HOME: configHomeFor(port) }
    const text = await runCli(['--probe'], env)
    const json = await runCli(['--probe', '--json'], env)
    expect(text.code).toBe(0)
    expect(text.stderr).toBe('')
    expect(text.stdout).toBe(`ok http://127.0.0.1:${port}: no reachable address to prove\n`)
    expect(json.code).toBe(text.code)
    expect(json.stderr).toBe('')
    const parsed = JSON.parse(json.stdout) as { ok: boolean; lines: ReportedLine[] }
    expect(parsed.ok).toBe(true)
    expect(parsed.lines).toEqual(reportedLines(text.stdout))
    expect(json.stdout.trim().split('\n')).toHaveLength(1)
  })
})

test('--probe --json keeps text mode failing exit and lines', async () => {
  await withDoor(503, async (port) => {
    const env = { XDG_CONFIG_HOME: configHomeFor(port) }
    const text = await runCli(['--probe'], env)
    const json = await runCli(['--json', '--probe'], env)
    expect(text.code).toBe(1)
    expect(text.stdout).toBe(
      `FAIL http://127.0.0.1:${port}: the door answered http 503 for its own model menu\n`,
    )
    expect(json.code).toBe(text.code)
    const parsed = JSON.parse(json.stdout) as { ok: boolean; lines: ReportedLine[] }
    expect(parsed.ok).toBe(false)
    expect(parsed.lines).toEqual(reportedLines(text.stdout))
  })
})

test('--probe --json includes discovery.claude.last_error when refresh fails', async () => {
  const lastError = 'GET /v1/models returned HTTP 401'
  await withDoor(
    200,
    async (port) => {
      const env = { XDG_CONFIG_HOME: configHomeFor(port) }
      const text = await runCli(['--probe'], env)
      const json = await runCli(['--probe', '--json'], env)
      expect(text.code).toBe(0)
      expect(text.stdout).toBe(`ok http://127.0.0.1:${port}: no reachable address to prove\n`)
      expect(text.stdout).not.toContain(lastError)
      expect(json.code).toBe(0)
      const parsed = JSON.parse(json.stdout) as {
        discovery: { claude: { last_error?: string; models: number; findings: unknown[] } }
      }
      expect(parsed.discovery.claude.last_error).toBe(lastError)
      expect(parsed.discovery.claude.models).toBe(4)
      expect(parsed.discovery.claude.findings).toEqual([])
    },
    {
      contract: CONTRACT,
      engines: [],
      discovery: {
        claude: {
          fetched_at: '2026-01-01T00:00:00.000Z',
          models: 4,
          last_error: lastError,
          findings: [],
        },
      },
    },
  )
})

test('--json without --engines or --probe is refused', async () => {
  const configHome = join(mkdtempSync(join(PROBE_ROOT, 'bare-')), 'config')
  mkdirSync(configHome, { recursive: true })
  const run = await runCli(['--json'], { XDG_CONFIG_HOME: configHome })
  expect(run.code).toBe(FatalError.EXIT_CODE)
  expect(run.stderr).toBe('--json requires --engines or --probe\n')
  expect(run.stdout).toBe('')
})

test('--engines --json prints the door engine list and does not start an engine', async () => {
  const seen: { method: string; path: string }[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      seen.push({ method: req.method, path })
      if (req.method === 'GET' && path === ENGINED_ENGINES_PATH) {
        return Response.json({ contract: CONTRACT, engines: [{ id: 'local-llama' }] })
      }
      return new Response('unhandled', { status: 404 })
    },
  })
  const port = server.port
  try {
    if (port === undefined) {
      throw new Error('the fake door did not bind a port')
    }
    const run = await runCli(['--engines', '--json'], { XDG_CONFIG_HOME: configHomeFor(port) })
    expect(run.code).toBe(0)
    expect(run.stderr).toBe('')
    const parsed = JSON.parse(run.stdout) as { contract: unknown; engines: unknown }
    expect(parsed.contract).toBe(6)
    expect(Array.isArray(parsed.engines)).toBe(true)
    expect(seen).toEqual([{ method: 'GET', path: ENGINED_ENGINES_PATH }])
  } finally {
    server.stop(true)
  }
})

test('--engines --json warns on stderr when the served config failed to reload', async () => {
  const configError = 'config.d/scratch.toml: expected a value'
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path === ENGINED_ENGINES_PATH) {
        return Response.json({
          contract: CONTRACT,
          engines: [{ id: 'local-llama' }],
          config_error: configError,
        })
      }
      return new Response('unhandled', { status: 404 })
    },
  })
  const port = server.port
  try {
    if (port === undefined) {
      throw new Error('the fake door did not bind a port')
    }
    const run = await runCli(['--engines', '--json'], { XDG_CONFIG_HOME: configHomeFor(port) })
    expect(run.code).toBe(0)
    expect(run.stderr).toContain(configError)
    expect(run.stderr).toBe(`${configError}\n`)
    const parsed = JSON.parse(run.stdout) as { config_error?: string; engines: unknown }
    expect(parsed.config_error).toBe(configError)
    expect(Array.isArray(parsed.engines)).toBe(true)
  } finally {
    server.stop(true)
  }
})

test('--engines without --json is refused, and so is combining it with --probe', async () => {
  const configHome = join(mkdtempSync(join(PROBE_ROOT, 'engines-flags-')), 'config')
  mkdirSync(configHome, { recursive: true })
  const env = { XDG_CONFIG_HOME: configHome }
  const bare = await runCli(['--engines'], env)
  expect(bare.code).toBe(FatalError.EXIT_CODE)
  expect(bare.stderr).toBe('--engines requires --json\n')
  expect(bare.stdout).toBe('')
  const both = await runCli(['--engines', '--probe'], env)
  expect(both.code).toBe(FatalError.EXIT_CODE)
  expect(both.stderr).toBe('--engines and --probe are mutually exclusive\n')
  expect(both.stdout).toBe('')
})
