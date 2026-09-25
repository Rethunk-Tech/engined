import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import type { AgenticSpawn } from './agentic.ts'
import type { AgenticProbeRunner } from './agenticProbe.ts'
import { resolveRedirect } from './agenticRedirect.ts'
import {
  CLAUDE_SPEC,
  chatRequest,
  claudeEngine,
  createLlamaDoor,
  fakeExec,
  LOCAL_LLAMA_SPEC,
  llamaExec,
  makeLlamaHttpClient,
  OPENCODE_SPEC,
  PASSING_PROBE,
  READY_200,
  TEST_DOOR_URL,
} from './doorFixtures.ts'
import type { ExecResult } from './exec.ts'
import { createDoor, type Door } from './main.ts'
import {
  BUNX,
  clearVerifiedVersion,
  collectLines,
  config,
  engine,
  makeTestRoot,
  route,
  tempPresetPath,
  writeEngineSpec,
} from './test-support.ts'
import type { Config, Upstream } from './types.ts'

const TEST_ROOT = makeTestRoot('engined-door-agentic-test-')

/** Moonshot serves an Anthropic-shaped endpoint, so claude's own launch redirects to it unchanged -- only its upstream differs. */
function moonshotUpstream(): Upstream {
  return {
    id: 'moonshot',
    base_url: 'https://api.kimi.com/coding/',
    secret: { service: 'moonshot-api', username: 'kimi-k2.7-code', header: 'x-api-key' },
    egress: 'remote',
    wire: 'anthropic',
  }
}

/** claude's real shipped spec, since the moonshot redirect is a route naming a different upstream on the same real agentic engine -- not a second, spec-less one. */
function redirectDoorRoot(): string {
  const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
  writeEngineSpec(root, 'claude', CLAUDE_SPEC)
  return root
}

/** What a faked claude spawn prints when its kimi-routed launch answers. */
const KIMI_ANSWER: ExecResult = {
  stdout: '{"is_error":false,"result":"answered via kimi"}',
  stderr: '',
  exitCode: 0,
}

/** An agentic chat request: one user message, launched in a scratch workdir. */
function scratchChatRequest(model: string, content = 'hi'): Request {
  return chatRequest({ model, messages: [{ role: 'user', content }], workdir: TEST_ROOT })
}

/** The chat request every kimi-routed test posts: the moonshot-routed claude model. */
function kimiChatRequest(content = 'hi'): Request {
  return scratchChatRequest('@/claude/kimi-k3', content)
}

/** claude routed to moonshot for kimi-k3, plus whatever other routes a test needs. */
function kimiRoutedConfig(...extraRoutes: ReturnType<typeof route>[]): Config {
  return config({
    engines: [claudeEngine()],
    upstreams: [moonshotUpstream()],
    routes: [route({ engine: 'claude', upstream: 'moonshot', model: 'kimi-k3' }), ...extraRoutes],
  })
}

/** A door over claude whose spawn is faked and whose secret lookup resolves to `secret` (or is left real when absent). */
function createClaudeDoor(cfg: Config, root: string, spawn: AgenticSpawn, secret?: string): Door {
  return createDoor(
    cfg,
    { enginesRoot: root, bunx: BUNX, agenticProbeRunner: PASSING_PROBE },
    {
      agenticSpawn: spawn,
      ...(secret === undefined ? {} : { secretExec: fakeExec(secret) }),
      write: () => undefined,
    },
  )
}

/** A real door over claude, routed to moonshot for one model, its resolved secret and every spawned argv/env recorded rather than actually launched. */
function createKimiDoor(ambientSibling = false): {
  door: Door
  spawnCalls: { argv: string[]; env: Record<string, string> }[]
} {
  const root = redirectDoorRoot()
  const cfg = config({
    engines: [claudeEngine()],
    upstreams: [moonshotUpstream()],
    routes: [
      route({ engine: 'claude', upstream: 'moonshot', model: 'kimi-k3' }),
      ...(ambientSibling ? [route({ engine: 'claude', upstream: null, model: 'kimi-k3' })] : []),
    ],
  })
  const spawnCalls: { argv: string[]; env: Record<string, string> }[] = []
  const spawn: AgenticSpawn = (spawnArgv, opts) => {
    spawnCalls.push({ argv: spawnArgv, env: opts.env })
    return Promise.resolve(KIMI_ANSWER)
  }
  const door = createDoor(
    cfg,
    {
      enginesRoot: root,
      bunx: BUNX,
      agenticProbeRunner: PASSING_PROBE,
    },
    {
      agenticSpawn: spawn,
      secretExec: fakeExec('kimi-secret-value'),
      agenticAmbientEnv: { HOME: '/home/test', GITHUB_TOKEN: 'ghp_leaked_repo_scope' },
      write: () => undefined,
    },
  )
  return { door, spawnCalls }
}

/** The stream-json lines a claude CLI prints for a two-chunk "pong". */
const STREAMED_PONG_LINES = [
  '{"type":"system","subtype":"init"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"po"}}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ng"}}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"pong"}',
]

/** A spawn that prints `lines` to stdout as it goes, recording each argv it was launched with. */
function streamingSpawn(lines: string[], argvSeen: string[][]): AgenticSpawn {
  return (spawnArgv, opts) => {
    argvSeen.push(spawnArgv)
    for (const line of lines) {
      opts.onStdout?.(`${line}\n`)
    }
    return Promise.resolve({ stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 })
  }
}

describe('the door: remote-agentic redirect streams as the CLI prints', () => {
  test('stream: true on an agentic hop is SSE chunks as the CLI prints them, launched in its streamed format', async () => {
    clearVerifiedVersion('claude')
    const argvSeen: string[][] = []
    const door = createClaudeDoor(
      kimiRoutedConfig(),
      redirectDoorRoot(),
      streamingSpawn(STREAMED_PONG_LINES, argvSeen),
      'k',
    )
    const res = await door.fetch(
      chatRequest({
        model: '@/claude/kimi-k3',
        messages: [{ role: 'user', content: 'ping' }],
        workdir: TEST_ROOT,
        stream: true,
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const text = await res.text()
    const contents = [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1])
    expect(contents).toEqual(['po', 'ng'])
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    expect(argvSeen[0]).toContain('stream-json')
    expect(argvSeen[0]).toContain('--include-partial-messages')
    expect(argvSeen[0]).not.toContain('json')
  })
})

describe('the door: remote-agentic redirect (claude routed to a moonshot upstream)', () => {
  test('the upstream segment picks the route: beside an ambient route on the same model, the three-segment address still redirects and the two-segment one runs ambient with the model in its env', async () => {
    clearVerifiedVersion('claude')
    const { door, spawnCalls } = createKimiDoor(true)
    const messages = [{ role: 'user', content: 'hi' }]
    const workdir = TEST_ROOT

    const redirected = await door.fetch(
      chatRequest({ model: '@/claude/moonshot/kimi-k3', messages, workdir }),
    )
    expect(redirected.status).toBe(200)
    expect(spawnCalls[0]?.env.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding/')

    const ambient = await door.fetch(chatRequest({ model: '@/claude/kimi-k3', messages, workdir }))
    expect(ambient.status).toBe(200)
    const env = spawnCalls[1]?.env ?? {}
    expect('ANTHROPIC_BASE_URL' in env).toBe(false)
    expect('ANTHROPIC_API_KEY' in env).toBe(false)
    expect(env.ANTHROPIC_MODEL).toBe('kimi-k3')
  })

  test('redirect variables and the resolved key reach the child env; ambient GITHUB_TOKEN does not; the full floor survives; the secret never appears in argv', async () => {
    clearVerifiedVersion('claude')
    const { door, spawnCalls } = createKimiDoor()
    const res = await door.fetch(kimiChatRequest())
    const body = (await res.json()) as { choices: { message: { content: string } }[] }
    expect(res.status).toBe(200)
    expect(body.choices[0]?.message.content).toBe('answered via kimi')

    expect(spawnCalls).toHaveLength(1)
    const { env, argv } = spawnCalls[0] ?? { env: {}, argv: [] }

    // Redirect variables and the resolved key reach the child; ambient GITHUB_TOKEN does not.
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding/')
    expect(env.ANTHROPIC_API_KEY).toBe('kimi-secret-value')
    expect(env.ANTHROPIC_MODEL).toBe('kimi-k3')
    expect('GITHUB_TOKEN' in env).toBe(false)
    expect(Object.values(env)).not.toContain('ghp_leaked_repo_scope')
    // secret.header "x-api-key": the Bearer variable is never set.
    expect('ANTHROPIC_AUTH_TOKEN' in env).toBe(false)

    // The full floor is still present in argv, all three flags individually.
    expect(argv).toContain('--safe-mode')
    expect(argv).toContain('--strict-mcp-config')
    const toolsIdx = argv.indexOf('--tools')
    expect(toolsIdx).toBeGreaterThan(-1)
    expect(argv[toolsIdx + 1]).toBe('Read,Grep,Glob')

    // The resolved secret appears nowhere in argv.
    expect(argv.some((a) => a.includes('kimi-secret-value'))).toBe(false)
    clearVerifiedVersion('claude')
  })
})

/**
 * An Anthropic-compatible Bearer gateway (OpenRouter-shaped): `secret.header`
 * is `authorization`, not `x-api-key`. Carries `secret.scheme = "Bearer"`,
 * same as the real config -- the CLI itself prepends "Bearer" to whatever
 * ANTHROPIC_AUTH_TOKEN carries, so the redirect must hand it the raw value.
 */
function bearerGatewayUpstream(): Upstream {
  return {
    id: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    secret: {
      service: 'openrouter-api',
      username: 'claude-code',
      header: 'authorization',
      scheme: 'Bearer',
    },
    egress: 'remote',
    wire: 'anthropic',
  }
}

describe('the door: remote-agentic redirect (claude routed to a Bearer-gateway upstream)', () => {
  test('secret.header "authorization" sets ANTHROPIC_AUTH_TOKEN to the RAW value even though secret.scheme is "Bearer" -- the CLI prepends its own, so redirectEnv must not double it', async () => {
    clearVerifiedVersion('claude')
    const root = redirectDoorRoot()
    const cfg = config({
      engines: [claudeEngine()],
      upstreams: [bearerGatewayUpstream()],
      routes: [route({ engine: 'claude', upstream: 'openrouter', model: 'sonnet-5' })],
    })
    const spawnCalls: { argv: string[]; env: Record<string, string> }[] = []
    const spawn: AgenticSpawn = (spawnArgv, opts) => {
      spawnCalls.push({ argv: spawnArgv, env: opts.env })
      return Promise.resolve({
        stdout: '{"is_error":false,"result":"answered via openrouter"}',
        stderr: '',
        exitCode: 0,
      })
    }
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, agenticProbeRunner: PASSING_PROBE },
      {
        agenticSpawn: spawn,
        secretExec: fakeExec('or-secret-value'),
        write: () => undefined,
      },
    )
    const res = await door.fetch(
      chatRequest({
        model: '@/claude/sonnet-5',
        messages: [{ role: 'user', content: 'hi' }],
        workdir: TEST_ROOT,
      }),
    )
    expect(res.status).toBe(200)
    expect(spawnCalls).toHaveLength(1)
    const { env } = spawnCalls[0] ?? { env: {} as Record<string, string> }

    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api/v1')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('or-secret-value')
    // Present and empty, not absent: an unset ANTHROPIC_API_KEY leaves the
    // CLI defaulting to x-api-key, which 401s against a Bearer-only gateway.
    expect('ANTHROPIC_API_KEY' in env).toBe(true)
    expect(env.ANTHROPIC_API_KEY).toBe('')
    clearVerifiedVersion('claude')
  })
})

describe('the door: remote-agentic redirect, unproved pin never reaches a spawn', () => {
  test('no agenticProbeRunner configured: the request is refused 503 and the spawn count stays zero', async () => {
    clearVerifiedVersion('claude')
    const root = redirectDoorRoot()
    const cfg = config({
      engines: [claudeEngine()],
      upstreams: [moonshotUpstream()],
      routes: [route({ engine: 'claude', upstream: 'moonshot', model: 'kimi-k3' })],
    })
    const spawnCalls: { argv: string[]; env: Record<string, string> }[] = []
    const spawn: AgenticSpawn = (spawnArgv, opts) => {
      spawnCalls.push({ argv: spawnArgv, env: opts.env })
      return Promise.resolve({
        stdout: '{"is_error":false,"result":"should never run"}',
        stderr: '',
        exitCode: 0,
      })
    }
    // No `agenticProbeRunner` in registryOpts: the pin has never been proved
    // and nothing can prove it, so the gate must refuse rather than serve.
    const door = createDoor(
      cfg,
      {
        enginesRoot: root,
        bunx: BUNX,
      },
      {
        agenticSpawn: spawn,
        secretExec: fakeExec('kimi-secret-value'),
        write: () => undefined,
      },
    )
    const res = await door.fetch(
      chatRequest({
        model: '@/claude/kimi-k3',
        messages: [{ role: 'user', content: 'hi' }],
        workdir: '/tmp/scratch',
      }),
    )

    expect(res.status).toBe(503)
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })
})

/** `resolveRedirect` for claude's kimi-k3 route onto `upstream`, with the secret lookup faked to `secret`. */
function redirectKimi(upstream: Upstream, cfg: Config, secret: string | undefined) {
  return resolveRedirect({
    upstream,
    engineId: 'claude',
    modelSeg: 'kimi-k3',
    config: cfg,
    doorUrl: TEST_DOOR_URL,
    secretExec: fakeExec(secret),
  })
}

describe('the door: remote-agentic redirect, missing secret', () => {
  test("a missing secret's HopResult carries the secret-tool store command", async () => {
    // Direct: runChain's own exhaustion wrapper replaces a lone hop's body
    // with a generic "every engine in this chain failed" once it classifies
    // a 5xx as advance-and-nothing-left-to-advance-to, so the fix text is
    // only observable on the HopResult resolveRedirect itself produces,
    // before runChain ever sees it. resolveRedirect takes the upstream
    // directly -- an engine has no address of its own to substitute onto.
    const redirect = await redirectKimi(moonshotUpstream(), config(), undefined)
    expect(redirect.ok).toBe(false)
    if (redirect.ok) {
      throw new Error('expected resolveRedirect to fail for a missing secret')
    }
    expect(redirect.result.status).toBe(503)
    const failBody = redirect.result.body as { error: string }
    expect(failBody.error).toContain('secret-tool store')
    expect(failBody.error).toContain('moonshot-api')
  })

  test('an upstream with a secret but no base_url refuses instead of redirecting nowhere', async () => {
    // Config requires a base_url alongside a secret but not the converse, so
    // this shape is legal and must not reach the child as an undefined
    // upstream.
    const addressless: Upstream = { ...moonshotUpstream(), base_url: undefined }
    const redirect = await redirectKimi(addressless, config(), 'k')
    expect(redirect.ok).toBe(false)
    if (redirect.ok) {
      throw new Error('expected resolveRedirect to fail without a base_url')
    }
    expect(redirect.result.status).toBe(502)
    expect((redirect.result.body as { error: string }).error).toContain('no configured base_url')
  })

  test("a route's wire_model reaches ANTHROPIC_MODEL, not the address segment", async () => {
    const cfg = config({
      routes: [
        route({
          engine: 'claude',
          model: 'kimi-k3',
          wire_model: 'moonshot/kimi-k3-0905',
          upstream: 'moonshot',
        }),
      ],
    })
    const redirect = await redirectKimi(moonshotUpstream(), cfg, 'k')
    expect(redirect.ok).toBe(true)
    if (!redirect.ok) {
      throw new Error('expected resolveRedirect to succeed')
    }
    expect(redirect.env.ANTHROPIC_MODEL).toBe('moonshot/kimi-k3-0905')
  })
})

describe('the door: remote-agentic redirect, missing secret does not take down other engines', () => {
  test('the local engine still serves, and the kimi attempt is reported as a clean 503', async () => {
    const root = redirectDoorRoot()
    writeEngineSpec(root, 'local-llama', LOCAL_LLAMA_SPEC)
    const cfg = config({
      engines: [
        claudeEngine(),
        engine({ id: 'local-llama', models_dir: '/data/gguf', models_max: 1 }),
      ],
      upstreams: [moonshotUpstream()],
      routes: [
        route({ engine: 'claude', upstream: 'moonshot', model: 'kimi-k3' }),
        route({ engine: 'local-llama', model: 'ornith', filename: 'x.gguf', role: 'chat' }),
      ],
    })
    const recorded: { body: string }[] = []
    const door = createLlamaDoor(cfg, root, {
      secretExec: fakeExec(undefined),
      llamaHttpClient: makeLlamaHttpClient(recorded),
      write: () => undefined,
    })

    const kimiRes = await door.fetch(
      chatRequest({
        model: '@/claude/kimi-k3',
        messages: [{ role: 'user', content: 'hi' }],
        workdir: '/tmp/scratch',
      }),
    )
    expect(kimiRes.status).toBe(503)

    const llamaRes = await door.fetch(
      chatRequest({ model: '@/local-llama/ornith', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(llamaRes.status).toBe(200)
  })
})

/** `${doorUrl}/chat/completions`, the request a launched child's own OpenAI-compatible traffic would make. */
function scopedChatRequest(doorUrl: string, body: unknown): Request {
  return new Request(`${doorUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The URL `redirectEnv` hands a child: the door on loopback, scoped by a 32-hex launch nonce. */
const RX_LAUNCH_SCOPED_DOOR_URL = /^http:\/\/127\.0\.0\.1:\d+\/openai\/v1\/[0-9a-f]{32}$/

/** What a faked opencode spawn prints when it answers. */
const OPENCODE_ANSWER: ExecResult = {
  stdout: '{"type":"text","part":{"text":"hi"}}\n{"type":"step_finish"}',
  stderr: '',
  exitCode: 0,
}

/** An engines root carrying opencode's spec, and a config with its one local route. */
function opencodeDoorConfig(): { cfg: Config; root: string } {
  const root = redirectDoorRoot()
  writeEngineSpec(root, 'opencode', OPENCODE_SPEC)
  const cfg = config({
    engines: [engine({ id: 'opencode', agent_version: '1.0.0' })],
    routes: [route({ engine: 'opencode', model: 'code', upstream: 'local' })],
  })
  return { cfg, root }
}

/** The door URL `renderOpencodeConfig` wrote into the rendered file at `path`. */
function renderedOpencodeBaseUrl(path: string): string {
  const rendered = JSON.parse(readFileSync(path, 'utf8')) as {
    provider: { engined: { options: { baseURL: string } } }
  }
  return rendered.provider.engined.options.baseURL
}

/**
 * `agent.configure` -- `renderOpencodeConfig` -- runs before `runAgentic`'s
 * own `bwrap` gate, so the rendered file carries the scoped URL whether or
 * not this box has a real `bwrap` at all. `ENGINED_BWRAP` is pointed at
 * `/bin/true`, present on every POSIX box, purely so the spawn (faked
 * regardless) is reached deterministically in CI. State lands in a fresh
 * `XDG_STATE_HOME` so no launch reads a file another test left behind.
 */
async function withOpencodeLaunchEnv(body: () => Promise<void>): Promise<void> {
  const previous = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    ENGINED_BWRAP: process.env.ENGINED_BWRAP,
  }
  process.env.XDG_STATE_HOME = mkdtempSync(join(TEST_ROOT, 'engined-state-'))
  process.env.ENGINED_BWRAP = '/bin/true'
  try {
    await body()
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  }
}

describe('the launch-scoped door', () => {
  /**
   * claude routed at moonshot: `redirectEnv`'s own path, and the one that
   * needs no `bwrap` (claude's floor is argv, not the sandbox) -- so this
   * exercises the real `resolveRedirect` -> `redirectEnv` wiring end to end
   * with nothing faked but the spawn.
   */
  test("redirectEnv's own output carries the launch-scoped door URL, and a child POSTing back to it naming an agentic engine is refused", async () => {
    const cfg = kimiRoutedConfig(route({ engine: 'claude', model: 'sonnet-5', upstream: null }))
    let capturedEnv: Record<string, string> = {}
    // The nonce lives only until runAgentic returns, so the recursive call
    // naming another agentic engine has to be made FROM INSIDE the fake
    // spawn, while the launch it belongs to is still in flight -- exactly
    // where a real child's own traffic would originate.
    let recursive: { status: number; body: string } | undefined
    const spawn: AgenticSpawn = async (_argv, opts) => {
      capturedEnv = opts.env
      const doorUrl = opts.env.ENGINED_DOOR_URL ?? ''
      // The refusal is keyed on the RESOLVED engine, not the literal
      // string -- a one-segment address that resolves to claude is the
      // same attack as naming "claude" outright.
      const res = await door.fetch(
        scopedChatRequest(doorUrl, {
          model: '@/claude/sonnet-5',
          messages: [{ role: 'user', content: 'escape' }],
        }),
      )
      recursive = { status: res.status, body: await res.text() }
      return KIMI_ANSWER
    }
    const door = createClaudeDoor(cfg, redirectDoorRoot(), spawn, 'kimi-secret-value')
    clearVerifiedVersion('claude')
    const res = await door.fetch(kimiChatRequest())
    expect(res.status).toBe(200)

    // redirectEnv's own output: the launch-scoped URL, not the plain door.
    expect(capturedEnv.ENGINED_DOOR_URL).toMatch(RX_LAUNCH_SCOPED_DOOR_URL)
    // The redirect itself is untouched by the door URL's addition.
    expect(capturedEnv.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding/')

    expect(recursive?.status).toBe(403)
    expect(recursive?.body).toContain('agentic')
    clearVerifiedVersion('claude')
  })

  test('the same address, off the launch-scoped prefix, is an ordinary request -- refused only on the scoped URL', async () => {
    const cfg = config({
      engines: [claudeEngine()],
      routes: [route({ engine: 'claude', model: 'sonnet-5', upstream: null })],
    })
    const spawn: AgenticSpawn = () =>
      Promise.resolve({ ...KIMI_ANSWER, stdout: '{"is_error":false,"result":"answered"}' })
    const door = createClaudeDoor(cfg, redirectDoorRoot(), spawn)
    clearVerifiedVersion('claude')
    const res = await door.fetch(scratchChatRequest('@/claude/sonnet-5'))
    expect(res.status).toBe(200)
    clearVerifiedVersion('claude')
  })
})

/** claude routed to moonshot beside a local llama, so a launched child has a non-agentic engine to call back to. */
function kimiBesideLlamaConfig(root: string): Config {
  writeEngineSpec(root, 'local-llama', LOCAL_LLAMA_SPEC)
  return config({
    engines: [
      claudeEngine(),
      engine({ id: 'local-llama', models_dir: '/data/gguf', models_max: 1 }),
    ],
    upstreams: [moonshotUpstream()],
    routes: [
      route({ engine: 'claude', upstream: 'moonshot', model: 'kimi-k3' }),
      route({ engine: 'local-llama', model: 'ornith', filename: 'x.gguf', role: 'chat' }),
    ],
  })
}

describe('the launch-scoped door: what a child may call back to', () => {
  test("a non-agentic engine's request is served on the launch-scoped URL, and still recorded", async () => {
    const root = redirectDoorRoot()
    const cfg = kimiBesideLlamaConfig(root)
    const recorded: { body: string }[] = []
    const { lines, write } = collectLines()
    // The nonce lives only until `runAgentic` returns, so the recursive,
    // non-agentic request has to be made FROM INSIDE the fake spawn, while
    // the launch it belongs to is still in flight.
    let innerStatus: number | undefined
    const spawn: AgenticSpawn = async (_argv, opts) => {
      const doorUrl = opts.env.ENGINED_DOOR_URL ?? ''
      const inner = await door.fetch(
        scopedChatRequest(doorUrl, {
          model: '@/local-llama/ornith',
          messages: [{ role: 'user', content: 'from the sandbox' }],
        }),
      )
      innerStatus = inner.status
      // The response body is a stream even for a buffered JSON reply
      // (readHopBody), and its provenance line is not emitted until the
      // stream is actually drained -- consume it or the line never lands.
      await inner.text()
      return KIMI_ANSWER
    }
    const door = createDoor(
      cfg,
      {
        enginesRoot: root,
        bunx: BUNX,
        exec: llamaExec(),
        probe: READY_200,
        agenticProbeRunner: PASSING_PROBE,
      },
      {
        agenticSpawn: spawn,
        secretExec: fakeExec('kimi-secret-value'),
        llamaHttpClient: makeLlamaHttpClient(recorded),
        llamaPresetHostPath: tempPresetPath(TEST_ROOT),
        write,
      },
    )
    clearVerifiedVersion('claude')
    const outer = await door.fetch(kimiChatRequest())
    expect(outer.status).toBe(200)
    // The inner, non-agentic request succeeded (200) from inside the launch.
    expect(innerStatus).toBe(200)
    // Still recorded: the launch-scoped local-llama call left its own
    // provenance line, egress-checked and accounted for like any other.
    expect(lines.some((l) => JSON.parse(l).attempts?.[0]?.engine === 'local-llama')).toBe(true)
    clearVerifiedVersion('claude')
  })
})

describe('the launch-scoped door: a nonce outlives nothing', () => {
  test('a request on a retired nonce is refused, regardless of which engine it names', async () => {
    let capturedDoorUrl = ''
    const spawn: AgenticSpawn = (_argv, opts) => {
      capturedDoorUrl = opts.env.ENGINED_DOOR_URL ?? ''
      return Promise.resolve(KIMI_ANSWER)
    }
    const door = createClaudeDoor(
      kimiRoutedConfig(),
      redirectDoorRoot(),
      spawn,
      'kimi-secret-value',
    )
    clearVerifiedVersion('claude')
    const res = await door.fetch(kimiChatRequest())
    expect(res.status).toBe(200)

    // The launch this nonce belonged to has already finished by the time
    // door.fetch() above resolved -- so it is retired here, before this
    // second, unrelated request ever names an engine at all.
    const stale = await door.fetch(
      scopedChatRequest(capturedDoorUrl, {
        model: '@/claude/kimi-k3',
        messages: [{ role: 'user', content: 'too late' }],
        workdir: '/tmp/scratch',
      }),
    )
    expect(stale.status).toBe(403)
    expect(JSON.stringify(await stale.json())).toContain('expired')
    clearVerifiedVersion('claude')
  })
})

describe('the launch-scoped door: the round-trip probe is a launch too', () => {
  /**
   * The probe spawns a real agent against a real door URL, so it is bounded
   * the way a caller's launch is: the URL it dials carries a nonce, an
   * address over it that resolves to an agentic-cli engine is refused, and
   * the nonce dies when the probe returns rather than standing open.
   */
  test('its dial-back URL is nonce-scoped, refuses an agentic hop, and expires with the probe', async () => {
    const { cfg, root } = opencodeDoorConfig()
    let doorUrl = ''
    let recursive: { status: number; body: string } | undefined
    const runner: AgenticProbeRunner = async (_version, _agent, roundTrip) => {
      doorUrl = roundTrip?.baseUrl ?? ''
      const res = await door.fetch(
        scopedChatRequest(doorUrl, {
          model: '@/opencode/code',
          messages: [{ role: 'user', content: 'escape' }],
          workdir: '/tmp/scratch',
        }),
      )
      recursive = { status: res.status, body: await res.text() }
      // Failing the pin stops the launch this probe was called for, so the
      // recursive call above is the only agent traffic the test produces.
      return { ok: false, failedProbe: 'answers-a-real-prompt' }
    }
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, agenticProbeRunner: runner },
      { write: () => undefined },
    )
    clearVerifiedVersion('opencode')
    const res = await door.fetch(scratchChatRequest('@/opencode/code'))
    expect(res.status).toBe(503)

    expect(doorUrl).toMatch(RX_LAUNCH_SCOPED_DOOR_URL)
    expect(recursive?.status).toBe(403)
    expect(recursive?.body).toContain('agentic')

    // Released when the probe returned: the same URL is unknown now, not a
    // standing key a leaked probe environment could keep using.
    const stale = await door.fetch(
      scopedChatRequest(doorUrl, {
        model: '@/opencode/code',
        messages: [{ role: 'user', content: 'too late' }],
        workdir: '/tmp/scratch',
      }),
    )
    expect(stale.status).toBe(403)
    expect(JSON.stringify(await stale.json())).toContain('expired')
    clearVerifiedVersion('opencode')
  })
})

describe("an agentic launch's args", () => {
  /**
   * `args` is legal on a `[[route]]` and passes the floor's own check at
   * parse, so a route naming one has to reach the child rather than
   * silently doing nothing -- and it beats the engine key it names, the
   * precedence every other args table on this box follows.
   */
  test("a route's args reach the spawned argv and beat the engine's own key, floor still ahead of both", async () => {
    const cfg = config({
      engines: [
        engine({
          id: 'claude',
          agent_version: '1.2.3',
          args: { model: 'engine-pin', verbose: true },
        }),
      ],
      routes: [
        route({
          engine: 'claude',
          model: 'sonnet-5',
          upstream: null,
          args: { model: 'route-pin' },
        }),
      ],
    })
    let argv: string[] = []
    const spawn: AgenticSpawn = (spawnArgv) => {
      argv = spawnArgv
      return Promise.resolve({ ...KIMI_ANSWER, stdout: '{"is_error":false,"result":"answered"}' })
    }
    const door = createClaudeDoor(cfg, redirectDoorRoot(), spawn)
    clearVerifiedVersion('claude')
    const res = await door.fetch(scratchChatRequest('@/claude/sonnet-5'))
    expect(res.status).toBe(200)

    // The engine key the route did not name still applies.
    expect(argv).toContain('--verbose')
    // One `--model`, carrying the route's value: a merge, not two copies
    // left to last-wins argument parsing.
    expect(argv.filter((a) => a === '--model')).toHaveLength(1)
    expect(argv[argv.indexOf('--model') + 1]).toBe('route-pin')
    // Neither table can get ahead of the read-only floor.
    expect(argv.indexOf('--safe-mode')).toBeLessThan(argv.indexOf('--model'))
    clearVerifiedVersion('claude')
  })
})

describe("the launch-scoped door: opencode's rendered config", () => {
  /**
   * The path itself is read from `OPENCODE_CONFIG` rather than a fixed
   * `stateDir()` filename -- `renderOpencodeConfig` `mkdtemp`s a fresh
   * directory per call, precisely so two launches in flight together never
   * share one file. The read happens from inside the fake spawn, before
   * `runAgentic`'s `finally` deletes it -- that deletion is asserted
   * separately, once `door.fetch` has returned.
   */
  test("renderOpencodeConfig's own rendered file carries the launch-scoped door URL, and is gone once the call ends", () =>
    withOpencodeLaunchEnv(async () => {
      const { cfg, root } = opencodeDoorConfig()
      let renderedPath = ''
      let capturedBaseUrl = ''
      const spawn: AgenticSpawn = (_argv, opts) => {
        renderedPath = opts.env.OPENCODE_CONFIG ?? ''
        capturedBaseUrl = renderedOpencodeBaseUrl(renderedPath)
        return Promise.resolve(OPENCODE_ANSWER)
      }
      const door = createClaudeDoor(cfg, root, spawn)
      clearVerifiedVersion('opencode')
      const res = await door.fetch(scratchChatRequest('@/opencode/code'))
      expect(res.status).toBe(200)
      expect(capturedBaseUrl).toMatch(RX_LAUNCH_SCOPED_DOOR_URL)
      // `runAgentic`'s `finally` already ran by the time `door.fetch` above
      // resolved: neither the file nor its `mkdtemp` directory survive it.
      expect(existsSync(renderedPath)).toBe(false)
      expect(existsSync(dirname(renderedPath))).toBe(false)
      clearVerifiedVersion('opencode')
    }))

  /**
   * Two opencode calls in flight together sharing one fixed `stateDir()`
   * path would be last-writer-wins: whichever spawn read the file after the
   * other launch's own write would run against a door URL never minted for
   * it. Both fake spawns here overlap on purpose (each awaits a beat before
   * reading its file) so that race window is actually exercised, not just
   * assumed closed.
   */
  test("two concurrent opencode launches never read each other's rendered config", () =>
    withOpencodeLaunchEnv(async () => {
      const { cfg, root } = opencodeDoorConfig()
      const paths: string[] = []
      const baseUrls: string[] = []
      const spawn: AgenticSpawn = async (_argv, opts) => {
        const path = opts.env.OPENCODE_CONFIG ?? ''
        paths.push(path)
        // Overlaps the other launch's own write-then-read window rather
        // than racing to read immediately, which would pass by luck alone.
        await new Promise((resolve) => setTimeout(resolve, 50))
        baseUrls.push(renderedOpencodeBaseUrl(path))
        return OPENCODE_ANSWER
      }
      const door = createClaudeDoor(cfg, root, spawn)
      clearVerifiedVersion('opencode')
      const results = await Promise.all(
        [1, 2].map((n) => door.fetch(scratchChatRequest('@/opencode/code', `hi ${n}`))),
      )
      expect(results.map((res) => res.status)).toEqual([200, 200])
      // Each launch minted its own nonce, so a fixed shared file would have
      // shown the same door URL read back for both -- whichever write lost
      // the race. Two distinct paths and two distinct URLs is the proof
      // neither launch ever read the other's file.
      expect(paths[0]).not.toBe(paths[1])
      expect(baseUrls[0]).not.toBe(baseUrls[1])
      expect(existsSync(paths[0] as string)).toBe(false)
      expect(existsSync(paths[1] as string)).toBe(false)
      clearVerifiedVersion('opencode')
    }))
})

describe("GET /openai/v1/models: an agentic engine's per-route state factors in that route's own upstream secret", () => {
  test('the ambient route reports installed; the route keyed to an upstream with no configured secret reports unavailable', async () => {
    clearVerifiedVersion('claude')
    const root = redirectDoorRoot()
    const cfg = config({
      engines: [claudeEngine()],
      upstreams: [moonshotUpstream()],
      routes: [
        route({ engine: 'claude', model: 'sonnet-5', upstream: null }),
        route({ engine: 'claude', model: 'k3', upstream: 'moonshot' }),
      ],
    })
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, agenticProbeRunner: PASSING_PROBE },
      { secretExec: fakeExec(undefined), write: () => undefined },
    )
    const res = await door.fetch(new Request('http://engined/openai/v1/models'))
    const body = (await res.json()) as { data: { id: string; state: string }[] }
    const ambient = body.data.find((r) => r.id === '@/claude/sonnet-5')
    // Different models on the one engine (not sibling routes on the SAME
    // model), so each keeps the plain two-segment id -- modelRowId only
    // reaches for the three-segment form when two routes share a model.
    const keyed = body.data.find((r) => r.id === '@/claude/k3')

    // The one proof this engine's pin carries -- the read-only floor -- is
    // upstream-independent, so both routes start from the same base state.
    // Only the keyed route's OWN secret resolution can pull it down from
    // there; the ambient probe passing does not vouch for it.
    expect(ambient?.state).toBe('installed')
    expect(keyed?.state).toBe('unavailable')
    clearVerifiedVersion('claude')
  })
})
