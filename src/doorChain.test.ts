import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import type { AgenticSpawn } from './agentic.ts'
import type { AgenticProbeRunner } from './agenticProbe.ts'
import { NAME_PREFIX } from './docker.ts'
import {
  CLAUDE_SPEC,
  chatRequest,
  claudeEngine,
  createLlamaDoor,
  LOCAL_LLAMA_SPEC,
  llamaDoorConfig,
  makeLlamaHttpClient,
  makeSplitHttpClient,
  PASSING_PROBE,
  READY_200,
  twoEngineDoorConfig,
  twoEngineExec,
} from './doorFixtures.ts'
import { timeoutSecondsForKind } from './hop.ts'
import type { HttpClient } from './http.ts'
import { createDoor, type Door } from './main.ts'
import {
  BUNX,
  buildExec,
  clearVerifiedVersion,
  collectLines,
  config,
  engine,
  llamaControlPlane,
  makeTestRoot,
  route,
  soleProvenanceRecord,
  tempPresetPath,
  writeEngineSpec,
} from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-door-test-')

function spawnDoor(opts: {
  cfg: Parameters<typeof createDoor>[0]
  root: string
  spawn: AgenticSpawn
  write: (line: string) => void
  probeRunner?: AgenticProbeRunner
}) {
  return createDoor(
    opts.cfg,
    {
      enginesRoot: opts.root,
      bunx: BUNX,
      agenticProbeRunner: opts.probeRunner ?? PASSING_PROBE,
    },
    { agenticSpawn: opts.spawn, write: opts.write },
  )
}

function chainHi(model = 'chain-x', workdir = '/tmp') {
  return chatRequest({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    workdir,
  })
}

function failoverDoor(status: number, deadCalls: string[], liveCalls: string[]) {
  const { cfg, root } = twoEngineDoorConfig(TEST_ROOT)
  return createLlamaDoor(
    cfg,
    root,
    {
      llamaHttpClient: makeSplitHttpClient(status, deadCalls, liveCalls),
      write: () => undefined,
    },
    twoEngineExec(),
  )
}

function failoverChat() {
  return chatRequest({
    model: 'chain-failover',
    messages: [{ role: 'user', content: 'hi' }],
  })
}

describe("timeoutSecondsForKind: the budget follows the hop's own engine kind", () => {
  test('an agentic-cli hop gets agent_timeout_seconds', () => {
    const cfg = config({ chat_timeout_seconds: 30, agent_timeout_seconds: 3600 })
    expect(timeoutSecondsForKind('agentic-cli', cfg)).toBe(3600)
  })

  test('every other kind gets chat_timeout_seconds -- including inside a chain', () => {
    const cfg = config({ chat_timeout_seconds: 30, agent_timeout_seconds: 3600 })
    expect(timeoutSecondsForKind('openai-http', cfg)).toBe(30)
    expect(timeoutSecondsForKind('tts', cfg)).toBe(30)
    expect(timeoutSecondsForKind(undefined, cfg)).toBe(30)
  })
})

describe('the door: chain timeout follows the hop, not the chain', () => {
  /**
   * `chat_timeout_seconds` is scoped to "one engine," per attempt, and being
   * part of a chain does not widen it: `chatTimeoutMs` owes
   * `agent_timeout_seconds` only to a hop that is itself agentic, so a chain
   * with no agentic hop anywhere in it never inherits the long agentic budget
   * it does not need. `chat_timeout_seconds` is set well under the
   * upstream's artificial delay and `agent_timeout_seconds` well over it, so
   * the outcome (timeout vs success) proves which budget actually applied.
   */
  test('a chain with no agentic hop times out on chat_timeout_seconds rather than surviving on agent_timeout_seconds', async () => {
    const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
    writeEngineSpec(root, 'local-llama', LOCAL_LLAMA_SPEC)
    const UpstreamDelayMs = 150
    const cfg = config({
      chat_timeout_seconds: 0.05,
      agent_timeout_seconds: 10,
      engines: [engine({ id: 'local-llama', models_dir: '/data/gguf', models_max: 1 })],
      routes: [route({ engine: 'local-llama', model: 'ornith', filename: 'x.gguf', role: 'chat' })],
      chains: { 'chain-x': ['@/local-llama/ornith'] },
    })
    const client: HttpClient = (url, init) => {
      if (url.endsWith('/models/load')) {
        return Promise.resolve(Response.json({ success: true }))
      }
      if (url.endsWith('/models/unload')) {
        return Promise.resolve(Response.json({ status: 'ok' }))
      }
      if (url.endsWith('/v1/models')) {
        return Promise.resolve(
          Response.json({ data: [{ id: 'ornith', status: { value: 'loaded' } }] }),
        )
      }
      // The chat completion call itself: artificially slow, and it actually
      // honours cancellation -- the real thing the fix has to reach in order
      // to matter, not just the number chatTimeoutMs computes.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(Response.json({ id: 'r1', choices: [{ message: { content: 'hi' } }] })),
          UpstreamDelayMs,
        )
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        })
      })
    }
    const { lines, write } = collectLines()
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: client,
      write,
    })

    const res = await door.fetch(
      chatRequest({ model: 'chain-x', messages: [{ role: 'user', content: 'hi' }] }),
    )
    await res.text()

    expect(res.status).toBe(503)
    expect(soleProvenanceRecord(lines).attempts[0]?.failure).toBe('timeout')
  })
})

describe('the door: a JSON body that is not a table is a 400', () => {
  // Each of these is valid JSON, so parsing cannot reject them -- only the
  // table check can. `null` is the one a `typeof body === "object"` guard
  // would wave through to a property read.
  const NotATable = ['null', '[]', '42', '"hi"']
  const BodyRoutes = ['/openai/v1/chat/completions', '/engined/v1/start']

  for (const pathname of BodyRoutes) {
    for (const raw of NotATable) {
      test(`${pathname} refuses ${raw}`, async () => {
        const door = createDoor(config(), { enginesRoot: '/nonexistent', bunx: BUNX })
        const res = await door.fetch(
          new Request(`http://engined${pathname}`, { method: 'POST', body: raw }),
        )
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: 'invalid JSON body' })
      })
    }
  }
})

describe('the door: content routing', () => {
  test('a chat against a resolvable llama model reaches the router and returns its body', async () => {
    const { cfg, root } = llamaDoorConfig(TEST_ROOT)
    const recorded: { body: string }[] = []
    const { lines, write } = collectLines()
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeLlamaHttpClient(recorded),
      write,
    })
    const res = await door.fetch(
      chatRequest({ model: '@/local-llama/ornith', messages: [{ role: 'user', content: 'hi' }] }),
    )
    const body = (await res.json()) as { choices: { message: { content: string } }[] }
    expect(body.choices[0]?.message.content).toBe('hi')
    expect(soleProvenanceRecord(lines).engine_used).toBe('local-llama')
  })

  test('workdir is stripped and reasoning_effort passes through to an openai-http hop', async () => {
    const { cfg, root } = llamaDoorConfig(TEST_ROOT)
    const recorded: { body: string }[] = []
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeLlamaHttpClient(recorded),
      write: () => undefined,
    })
    const res = await door.fetch(
      chatRequest({
        model: '@/local-llama/ornith',
        messages: [{ role: 'user', content: 'hi' }],
        workdir: '/should/not/reach/llama',
        reasoning_effort: 'high',
      }),
    )
    // The response is a lazily-produced stream: reading it to completion is
    // what actually drives `runLease`'s upstream call, the same as a real
    // consumer would.
    await res.text()
    expect(recorded).toHaveLength(1)
    const forwarded = JSON.parse(recorded[0]?.body ?? '{}') as Record<string, unknown>
    expect(forwarded.workdir).toBeUndefined()
    expect(forwarded.reasoning_effort).toBe('high')
  })
})

describe('the door: agentic and chain routing', () => {
  // The 400-without-workdir shape itself is covered by two survivors:
  // agentic.test.ts's "runAgentic: workdir absent is 400 and never spawns"
  // (the function, including the never-spawns assertion) and
  // integration.test.ts's "an agentic attempt with no workdir returns 400"
  // (the same rejection through a real door).

  test('an unproved agentic engine does not spawn', async () => {
    const id = 'claude-unproved'
    clearVerifiedVersion(id)
    const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
    writeEngineSpec(root, id, CLAUDE_SPEC)
    const cfg = config({
      routes: [route({ engine: id, model: 'assistant', upstream: null })],
      engines: [engine({ id, agent_version: '9.9.9' })],
    })
    const spawnCalls: unknown[] = []
    const fakeSpawn: AgenticSpawn = (argv, opts) => {
      spawnCalls.push({ argv, opts })
      return Promise.resolve({
        stdout: '{"is_error":false,"result":"hi"}',
        stderr: '',
        exitCode: 0,
      })
    }
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX },
      { agenticSpawn: fakeSpawn, write: () => undefined },
    )
    const res = await door.fetch(
      chatRequest({
        model: `@/${id}/assistant`,
        messages: [{ role: 'user', content: 'hi' }],
        workdir: '/tmp',
      }),
    )
    // A lone-hop dispatch that fails now advances like any other unavailable
    // engine (finding 1), so it lands in runChain's own generic "every
    // engine in this chain failed" exhaustion body -- the same wrapping the
    // secret-resolution path's equivalent 503 already goes through. The
    // per-engine fix text (naming `id` and "9.9.9") still exists, just on
    // the `HopResult` before runChain gets it; see `execAgentic`'s proof-gate
    // branch and the "missing secret" test below for that assertion.
    expect(res.status).toBe(503)
    expect(spawnCalls).toHaveLength(0)
  })
})

describe('the door: chain skips an engine that fails its version proof', () => {
  /**
   * A chain skips an unavailable engine. An engine that
   * cannot prove its agent_version pin is exactly "unavailable" -- the
   * same 503 the secret-resolution path already produces (`resolveRedirect`,
   * plain 503, no `envelopeFailure`) and the chain advances past that one.
   * The version-proof 503 has to stay envelope-free for the same reason:
   * `classifyResult` treats `envelopeFailure` as never-advancing regardless of
   * status, which would make the first hop terminal instead of skipped.
   */
  test('a chain whose first hop fails its version proof advances to the second hop', async () => {
    const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
    for (const id of ['claude-unproved', 'claude-b']) {
      writeEngineSpec(root, id, CLAUDE_SPEC)
    }
    clearVerifiedVersion('claude-unproved')
    clearVerifiedVersion('claude-b')
    const cfg = config({
      engines: [
        engine({ id: 'claude-unproved', agent_version: '1.2.3' }),
        engine({ id: 'claude-b', agent_version: '4.5.6' }),
      ],
      chains: { 'chain-x': ['@/claude-unproved/x', '@/claude-b/y'] },
    })
    // Only claude-b's pin is provable -- claude-unproved's proof always
    // fails, the same as the standalone "unproved agentic engine" test above.
    const probeRunner: AgenticProbeRunner = (version) =>
      Promise.resolve(version === '4.5.6' ? { ok: true } : { ok: false, failedProbe: 'boom' })
    const hopBCalls: string[][] = []
    const spawn: AgenticSpawn = (argv) => {
      hopBCalls.push(argv)
      return Promise.resolve({
        stdout: '{"is_error":false,"result":"hi"}',
        stderr: '',
        exitCode: 0,
      })
    }
    const { lines, write } = collectLines()
    const door = spawnDoor({ cfg, root, spawn, write, probeRunner })
    const res = await door.fetch(chainHi())
    expect(res.status).toBe(200)
    expect(hopBCalls).toHaveLength(1)
    expect(hopBCalls[0]).toContain('@anthropic-ai/claude-code@4.5.6')
    expect(soleProvenanceRecord(lines).engine_used).toBe('claude-b')
    clearVerifiedVersion('claude-unproved')
    clearVerifiedVersion('claude-b')
  })
})

describe("the door: an agentic hop's own timeout actually aborts it", () => {
  /**
   * agent_timeout_seconds is computed, threaded through runOneHop's per-hop
   * timeout, and then reached a spawn that never listened for it -- so a
   * hung `claude -p` held its chain slot forever regardless of the budget.
   * This spawn double never resolves on its own, only on `opts.signal`
   * firing -- exactly what the real `defaultAgenticSpawn` now does, and
   * exactly what exposes whether the signal actually reaches it: with the
   * old, unwired `execAgentic`/`buildHopExec`, `opts.signal` is undefined
   * here and this promise never settles, so the request hangs until bun's
   * own test timeout fails it rather than the door's short budget.
   */
  test('a hung agentic spawn is aborted by agent_timeout_seconds instead of holding its slot forever', async () => {
    const id = 'claude-hangs'
    clearVerifiedVersion(id)
    const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
    writeEngineSpec(root, id, CLAUDE_SPEC)
    const workdir = mkdtempSync(join(TEST_ROOT, 'engined-workdir-'))
    const cfg = config({
      routes: [route({ engine: id, model: 'assistant', upstream: null })],
      // Well under bun's own per-test timeout, so a correct fix resolves
      // fast and a regression fails this test rather than hanging the suite.
      agent_timeout_seconds: 0.05,
      engines: [engine({ id, agent_version: '1.2.3' })],
    })
    const spawn: AgenticSpawn = (_argv, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const { lines, write } = collectLines()
    const door = spawnDoor({ cfg, root, spawn, write })
    const res = await door.fetch(chainHi(`@/${id}/assistant`, workdir))
    await res.text()

    expect(res.status).toBe(503)
    expect(soleProvenanceRecord(lines).attempts[0]?.failure).toBe('timeout')
    clearVerifiedVersion(id)
  })
})

describe('the door: chain routing', () => {
  test("a chain whose first hop's envelope fails is terminal there: the second hop's own spawn log stays empty", async () => {
    const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
    for (const id of ['claude-a', 'claude-b']) {
      writeEngineSpec(root, id, CLAUDE_SPEC)
    }
    clearVerifiedVersion('claude-a')
    clearVerifiedVersion('claude-b')
    // Distinct pins so one shared spawn can tell the hops apart by argv and
    // keep a separate call log per hop -- the discriminating assertion is
    // against the next hop's own log, not the response status.
    const cfg = config({
      engines: [
        engine({ id: 'claude-a', agent_version: '1.2.3' }),
        engine({ id: 'claude-b', agent_version: '4.5.6' }),
      ],
      chains: { 'chain-x': ['@/claude-a/x', '@/claude-b/y'] },
    })
    const hopACalls: string[][] = []
    const hopBCalls: string[][] = []
    // claude-a's stdout fails to parse -- a proven envelope failure, terminal
    // regardless of status, never a transport error a retry might route around.
    const spawn: AgenticSpawn = (argv) => {
      ;(argv.includes('@anthropic-ai/claude-code@1.2.3') ? hopACalls : hopBCalls).push(argv)
      return Promise.resolve({ stdout: 'not json', stderr: '', exitCode: 0 })
    }
    const { lines, write } = collectLines()
    const door = spawnDoor({ cfg, root, spawn, write })
    const res = await door.fetch(chainHi())
    expect(res.status).toBe(502)
    expect(hopACalls).toHaveLength(1)
    expect(hopBCalls).toHaveLength(0)
    const record = soleProvenanceRecord(lines)
    expect(record.engine_used).toBe('claude-a')
    expect(record.attempts).toHaveLength(1)
    expect(record.attempts[0]).toMatchObject({ engine: 'claude-a', ok: false })
    clearVerifiedVersion('claude-a')
    clearVerifiedVersion('claude-b')
  })
})

describe("the door: a llama hop's real status decides chain advance", () => {
  test("a 500 from the first hop advances: the second hop's upstream received a request", async () => {
    const deadCalls: string[] = []
    const liveCalls: string[] = []
    const res = await failoverDoor(500, deadCalls, liveCalls).fetch(failoverChat())
    const body = (await res.json()) as { choices: { message: { content: string } }[] }
    expect(res.status).toBe(200)
    expect(body.choices[0]?.message.content).toBe('live')
    expect(deadCalls.length).toBeGreaterThan(0)
    expect(liveCalls.length).toBeGreaterThan(0)
  })

  test("a 400 from the first hop does not advance: the second hop's upstream is never touched", async () => {
    const deadCalls: string[] = []
    const liveCalls: string[] = []
    const res = await failoverDoor(400, deadCalls, liveCalls).fetch(failoverChat())
    await res.text()
    expect(res.status).toBe(400)
    expect(deadCalls.length).toBeGreaterThan(0)
    expect(liveCalls).toHaveLength(0)
  })
})

const TOOL_FALLBACK_LLAMA_PORT = 46_003

const TOOL_CALL_ANSWER = {
  id: 'resp-tools',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'now', arguments: '{}' } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
}

/**
 * A chain that falls back off a tool-capable llama hop onto an agentic one.
 * `chain-public` in `config.example.toml` has this exact shape, and a
 * consumer running a real tool loop over it (majordomo does) gets whatever
 * the last hop returns.
 *
 * `chain-rev` is the same pair the other way round, for the case where the
 * agentic hop is the one reached first: `llamaAnswers` then makes the llama
 * hop behind it a live one, so what the caller gets back proves the chain
 * reached it rather than merely that the agentic hop was skipped.
 */
function toolFallbackDoor(spawnCalls: string[][], llamaAnswers = false): Door {
  const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
  writeEngineSpec(root, 'llama-dead', LOCAL_LLAMA_SPEC)
  writeEngineSpec(root, 'claude', CLAUDE_SPEC)
  clearVerifiedVersion('claude')
  const cfg = config({
    engines: [
      engine({ id: 'llama-dead', models_dir: '/data/dead', models_max: 1 }),
      claudeEngine(),
    ],
    routes: [
      route({ engine: 'llama-dead', model: 'dead-model', filename: 'd.gguf', role: 'chat' }),
      route({ engine: 'claude', model: 'x', upstream: null }),
    ],
    chains: {
      'chain-tools': ['@/llama-dead/dead-model', '@/claude/x'],
      'chain-rev': ['@/claude/x', '@/llama-dead/dead-model'],
      // No hop here can honour a tool call, and none reads a workdir from a
      // caller who addressed the chain: the two refusals a chain caller can
      // meet, with nothing behind either to soften them.
      'chain-agentic-only': ['@/claude/x'],
    },
  })
  const control = llamaControlPlane()
  const llamaHttpClient: HttpClient = (url, init) =>
    Promise.resolve(
      control(url, init) ??
        (llamaAnswers
          ? Response.json(TOOL_CALL_ANSWER)
          : Response.json({ error: 'dead' }, { status: 500 })),
    )
  return createDoor(
    cfg,
    {
      enginesRoot: root,
      bunx: BUNX,
      exec: buildExec({
        portByContainer: { [`${NAME_PREFIX}llama-dead`]: TOOL_FALLBACK_LLAMA_PORT },
      }),
      probe: READY_200,
      agenticProbeRunner: PASSING_PROBE,
    },
    {
      llamaPresetHostPath: tempPresetPath(TEST_ROOT),
      llamaHttpClient,
      agenticSpawn: (argv) => {
        spawnCalls.push(argv)
        return Promise.resolve({
          stdout: '{"is_error":false,"result":"here is prose"}',
          stderr: '',
          exitCode: 0,
        })
      },
      write: () => undefined,
    },
  )
}

/** Every tool-refusal case sends the same function under both spellings; only the body shape around it differs. */
const TOOL_NOW = { type: 'function', function: { name: 'now', parameters: {} } }

/** One tool-fallback door per call, posted a chat body and read back whole -- the spawn log is what proves the agent was never reached. */
interface ToolFallbackBody {
  choices?: { finish_reason?: string }[]
  error?: string
  attempts?: { failure?: string }[]
}

async function toolFallbackCall(
  body: Record<string, unknown>,
  agenticFirst = false,
): Promise<{ status: number; body: ToolFallbackBody; spawnCalls: string[][] }> {
  const spawnCalls: string[][] = []
  const door = toolFallbackDoor(spawnCalls, agenticFirst)
  const res = await door.fetch(chatRequest(body))
  return { status: res.status, body: (await res.json()) as ToolFallbackBody, spawnCalls }
}

describe('the door: a tool call never falls back into prose', () => {
  test('a chain falling off a llama hop onto an agentic one refuses the tools it cannot honour instead of answering', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: 'chain-tools',
      messages: [{ role: 'user', content: 'what time is it' }],
      workdir: '/tmp',
      tools: [TOOL_NOW],
      parallel_tool_calls: true,
    })
    // The agent is never launched at all, so there is no prose to return.
    // A tool-capable hop was in this chain and merely failed, so the refusal
    // advances and the chain exhausts -- it does not terminate on the caller.
    expect(spawnCalls).toHaveLength(0)
    expect(status).toBe(503)
    expect(body.error).toBe('every engine in this chain failed')
    expect(body.attempts).toHaveLength(2)
    expect(body.choices).toBeUndefined()
    clearVerifiedVersion('claude')
  })

  // `workdir` means nothing to the llama hop that answers this, so the caller
  // had no reason to send one -- and the agentic hop it is reached through
  // must not turn that into a terminal 400 the chain cannot get past.
  test('a chain whose first hop is agentic still reaches the tool-capable hop behind it with no workdir sent', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall(
      {
        model: 'chain-rev',
        messages: [{ role: 'user', content: 'what time is it' }],
        tools: [TOOL_NOW],
      },
      true,
    )
    expect(status).toBe(200)
    expect(body.choices?.[0]?.finish_reason).toBe('tool_calls')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })
})

describe("the door: a missing workdir is the chain's business, not the caller's", () => {
  // `workdir` is meaningful to an agentic hop and to nothing else, so a
  // caller who addressed a chain had no reason to send one. The hop that
  // cannot run without it is a shape mismatch like any other, whether or not
  // the body also carries a field this engine cannot honour.
  test('a chain whose first hop is agentic advances past it when no workdir and no tools were sent', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall(
      {
        model: 'chain-rev',
        messages: [{ role: 'user', content: 'what time is it' }],
      },
      true,
    )
    expect(status).toBe(200)
    expect(body.choices?.[0]?.finish_reason).toBe('tool_calls')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })

  // The counterpart the advance must not swallow: naming the engine itself
  // makes the omission the caller's own, and it stays terminal.
  test('naming the agentic engine directly with no workdir is still a terminal 400 naming it', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: '@/claude/x',
      messages: [{ role: 'user', content: 'what time is it' }],
    })
    expect(status).toBe(400)
    expect(body.error).toContain('workdir is required')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })
})

describe('the door: a chain nothing in it can honour answers the caller, not a dead engine', () => {
  // No hop can honour `tools`, so the refusal is terminal wherever it is
  // reached from -- and a caller who left out the `workdir` only an agentic
  // hop reads still gets told the one thing they can act on.
  test('an all-agentic chain names the field it cannot honour even with no workdir sent', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: 'chain-agentic-only',
      messages: [{ role: 'user', content: 'what time is it' }],
      tools: [TOOL_NOW],
    })
    expect(status).toBe(400)
    expect(body.error).toContain('cannot honour tools')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })

  // The missing workdir still advances, and the exhausted chain has to say
  // what actually happened: `http 502` alone reads as an engine that failed.
  test('an all-agentic chain with no workdir exhausts, and the attempt records why', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: 'chain-agentic-only',
      messages: [{ role: 'user', content: 'what time is it' }],
    })
    expect(status).toBe(503)
    expect(body.attempts).toHaveLength(1)
    expect(body.attempts?.[0]?.failure).toContain('carried no workdir')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })

  test('a max_egress that is not an egress is a 400 naming the values that are', async () => {
    const { status, body } = await toolFallbackCall({
      model: 'chain-agentic-only',
      messages: [{ role: 'user', content: 'what time is it' }],
      max_egress: 'internet',
    })
    expect(status).toBe(400)
    expect(body.error).toBe('max_egress must be one of: none, lan, remote')
  })
})

describe('the door: an agentic engine named directly refuses the tool field by name', () => {
  test('naming the agentic engine directly is terminal and names the field, not a 503 that reads as a dead box', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: '@/claude/x',
      messages: [{ role: 'user', content: 'what time is it' }],
      workdir: '/tmp',
      tools: [TOOL_NOW],
    })
    expect(status).toBe(400)
    expect(body.error).toContain('cannot honour tools')
    expect(spawnCalls).toHaveLength(0)
    expect(body.choices).toBeUndefined()
    clearVerifiedVersion('claude')
  })

  test('the legacy functions/function_call spelling is refused too, not answered in prose', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: '@/claude/x',
      messages: [{ role: 'user', content: 'what time is it' }],
      workdir: '/tmp',
      functions: [TOOL_NOW.function],
      function_call: 'auto',
    })
    expect(status).toBe(400)
    expect(body.error).toContain('cannot honour functions')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })
})

describe('the door: a body that demands no tool call is answered', () => {
  test('the shapes that demand nothing -- empty tools, tool_choice none, text response_format -- are answered', async () => {
    const { status, spawnCalls } = await toolFallbackCall({
      model: '@/claude/x',
      messages: [{ role: 'user', content: 'what time is it' }],
      workdir: '/tmp',
      tools: [],
      tool_choice: 'none',
      parallel_tool_calls: false,
      response_format: { type: 'text' },
    })
    expect(status).toBe(200)
    expect(spawnCalls).toHaveLength(1)
    clearVerifiedVersion('claude')
  })

  test('a caller who also forgot workdir is told about the workdir, which is the mistake they own first', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: '@/claude/x',
      messages: [{ role: 'user', content: 'what time is it' }],
      tools: [TOOL_NOW],
    })
    expect(status).toBe(400)
    expect(body.error).toContain('workdir is required')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })

  // A non-empty tool list under `tool_choice: "none"` is the only shape a
  // client that carries tools and wants words actually sends, so refusing it
  // would refuse the traffic this whole refusal exists to keep serving.
  test('a real tool list under tool_choice "none" is answered, not refused for carrying one', async () => {
    const { status, spawnCalls } = await toolFallbackCall({
      model: '@/claude/x',
      messages: [{ role: 'user', content: 'what time is it' }],
      workdir: '/tmp',
      tools: [TOOL_NOW],
      tool_choice: 'none',
    })
    expect(status).toBe(200)
    expect(spawnCalls).toHaveLength(1)
    clearVerifiedVersion('claude')
  })
})

describe('the door: which addresses forward a tool call is discoverable', () => {
  test('the models menu says which addresses forward a tool call before the first one is sent', async () => {
    const door = toolFallbackDoor([])
    const res = await door.fetch(new Request('http://engined/openai/v1/models'))
    const { data } = (await res.json()) as { data: { id: string; tools: boolean }[] }
    expect(data.find((r) => r.id === 'chain-tools')?.tools).toBe(false)
    expect(data.find((r) => r.id === '@/llama-dead/dead-model')?.tools).toBe(true)
    clearVerifiedVersion('claude')
  })

  test('the same chain without tool-calling fields still falls back and answers', async () => {
    const spawnCalls: string[][] = []
    const door = toolFallbackDoor(spawnCalls)
    const res = await door.fetch(
      chatRequest({
        model: 'chain-tools',
        messages: [{ role: 'user', content: 'what time is it' }],
        workdir: '/tmp',
      }),
    )
    expect(res.status).toBe(200)
    expect(spawnCalls).toHaveLength(1)
    clearVerifiedVersion('claude')
  })
})
