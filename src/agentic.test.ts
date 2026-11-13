import { expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import process from 'node:process'
import {
  type AgenticSpawn,
  buildArgv,
  buildChildEnv,
  defaultAgenticSpawn,
  renderEmptyMcpConfig,
  runAgentic,
} from './agentic.ts'
import {
  AGENTIC_FLOOR,
  argKeysAsFlags,
  argvFromArgs,
  assertNoForbiddenFlags,
  CURSOR_FLOOR,
  FORBIDDEN_AGENTIC_FLAGS,
} from './agenticArgs.ts'
import { promptsFromMessages, researchMode } from './agenticHop.ts'
import { buildAgenticProbeRunner } from './agenticProbeHarness.ts'
import { applySandboxFloor } from './agenticSandbox.ts'
import { pipedArgv, scopedArgv } from './agentScope.ts'
// The envelope parser moved to agents.ts with the rest of what varies per
// agent; these cases stay here because they are about the launch path.
import { agentCli, parseClaudeEnvelope as parseEnvelope } from './agents.ts'
// Read-only import: proves the real reachable path (config parse), not just
// the shared validator in isolation. This file does not edit config.ts.
import { loadConfig } from './config.ts'
import type { ExecResult } from './exec.ts'
import { loopbackPorts, sandboxHome } from './sandbox.ts'
import { BUNX, makeTestRoot } from './test-support.ts'

const PIN = '1.2.3'
const MCP_CONFIG_PATH = '/state/agentic-mcp-empty.json'
const RX_TOOLS_FLAG = /--tools/
const RX_DISSOLVES_FLOOR = /dissolves the read-only floor/

const TEST_ROOT = makeTestRoot('engined-agentic-test-')

test('applySandboxFloor: an unreadable login rejects and leaves no launch home', () => {
  const dir = mkdtempSync(join(TEST_ROOT, 'engined-agentic-login-'))
  const loginFile = join(dir, 'credentials')
  writeFileSync(loginFile, 'secret')
  chmodSync(loginFile, 0o000)
  const claude = agentCli('claude')
  if (claude === undefined) {
    throw new Error('claude agent')
  }
  const agent = {
    ...claude,
    id: basename(dir),
    // copyLogins joins `from` onto the operator home, so this has to be relative.
    logins: [{ from: relative(homedir(), loginFile), to: '.config/credentials' }],
  }
  const launches = (): string[] =>
    readdirSync(sandboxHome(agent.id)).filter((name) => name.startsWith('launch-'))
  try {
    expect(() =>
      applySandboxFloor(agent, {
        workdir: dir,
        argv: ['/bin/true'],
        env: {},
        bwrapOverride: '/bin/true',
        pasta: '/bin/true',
        readOnly: [],
      }),
    ).toThrow()
    expect(launches()).toEqual([])
  } finally {
    chmodSync(loginFile, 0o600)
  }
})

/** Every flag another kind's spec.toml plausibly carries in `[engine.args]`, none of them one engined itself prepends or a forbidden one. */
const MANY_OTHER_ARGS: Record<string, unknown> = {
  'max-turns': 8,
  model: 'sonnet',
  'append-system-prompt': 'be terse',
  'no-color': false,
  cwd: undefined,
  'session-id': 'abc-123',
}

test('scopedArgv: gives each agent its own memory-capped scope, and falls back to the bare argv without systemd-run', () => {
  const scoped = scopedArgv(['/bin/claude', '-p'], '/usr/bin/systemd-run')
  expect(scoped.slice(0, 3)).toEqual(['/usr/bin/systemd-run', '--user', '--scope'])
  expect(scoped).toContain('MemoryMax=2G')
  expect(scoped.slice(scoped.indexOf('--') + 1)).toEqual(['/bin/claude', '-p'])
  expect(scopedArgv(['/bin/claude'], null)).toEqual(['/bin/claude'])
})

test("buildArgv: the floor's three flags all survive a long list of other args, and none of the four forbidden flags appear", () => {
  const argv = buildArgv({
    bunx: BUNX,
    agent: 'claude',
    agentVersion: PIN,
    args: MANY_OTHER_ARGS,
    mcpConfigPath: MCP_CONFIG_PATH,
  })

  expect(argv).toContain('--safe-mode')
  expect(argv).toContain('--strict-mcp-config')
  const toolsIndex = argv.indexOf('--tools')
  expect(toolsIndex).toBeGreaterThan(-1)
  expect(argv[toolsIndex + 1]).toBe('Read,Grep,Glob')

  for (const forbidden of FORBIDDEN_AGENTIC_FLAGS) {
    expect(argv).not.toContain(forbidden)
  }
})

test('buildArgv: research replaces claude file tools with the web tools while normal calls retain them', () => {
  const normal = buildArgv({
    bunx: BUNX,
    agent: 'claude',
    agentVersion: PIN,
    args: {},
    mcpConfigPath: MCP_CONFIG_PATH,
  })
  const research = buildArgv({
    bunx: BUNX,
    agent: 'claude',
    agentVersion: PIN,
    args: {},
    mcpConfigPath: MCP_CONFIG_PATH,
    research: true,
  })

  expect(normal).toContain('Read,Grep,Glob')
  expect(research[research.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch')
  expect(research).not.toContain('Read,Grep,Glob')
  expect(research).toContain('--safe-mode')
  expect(research).toContain('--strict-mcp-config')
})

test('researchMode: accepts true, false and absence, but rejects non-boolean values', () => {
  expect(researchMode({ research: true })).toEqual({ ok: true, research: true })
  expect(researchMode({ research: false })).toEqual({ ok: true, research: false })
  expect(researchMode({})).toEqual({ ok: true, research: false })
  expect(researchMode({ research: 'true' })).toEqual({
    ok: false,
    error: 'research must be a boolean when present',
  })
})

test.each([
  [{ verbose: true }, ['--verbose']],
  [{ ngl: 99 }, ['--ngl', '99']],
  [{ name: 'x' }, ['--name', 'x']],
  [{ verbose: false }, []],
  [{ gone: null }, []],
  [{ gone: undefined }, []],
  [{ verbose: true, ngl: 1, skip: false }, ['--verbose', '--ngl', '1']],
])('argvFromArgs: %j', (args, want) => {
  expect(argvFromArgs(args)).toEqual(want)
})

test('argKeysAsFlags names every key, including a false that argvFromArgs would drop', () => {
  expect(argKeysAsFlags({ force: false, verbose: true })).toEqual(['--force', '--verbose'])
})

// buildArgv itself stays a dumb assembler: it does not reject anything.
// assertNoForbiddenFlags is the choke point, at config parse and again in
// runAgentic before spawn. These tests exercise both, plus loadConfig end
// to end, rather than only the shape buildArgv would produce.

test('assertNoForbiddenFlags: every floor flag is rejected if a config names it, and the thrown message names it', () => {
  const floorFlagNames = AGENTIC_FLOOR.filter((token) => token.startsWith('--'))
  expect(floorFlagNames).toEqual(['--safe-mode', '--tools', '--strict-mcp-config'])

  for (const floorFlag of floorFlagNames) {
    expect(() => assertNoForbiddenFlags([floorFlag], 'config.toml')).toThrow(floorFlag)
  }

  // The real call site (config.ts:158) never sees the floor -- it validates
  // only what argsToArgv rendered from `[engine.args]` itself, exactly this
  // shape for `tools = "Bash,Write"`: a value alongside the flag, not the
  // bare flag the loop above used.
  expect(() => assertNoForbiddenFlags(['--tools', 'Bash,Write'], 'config.toml')).toThrow(
    RX_TOOLS_FLAG,
  )
})

test("assertNoForbiddenFlags: a long list of ordinary args that name none of the floor's flags still passes clean", () => {
  const argv = ['--max-turns', '8', '--model', 'sonnet', '--no-color']

  expect(() => assertNoForbiddenFlags(argv, 'config.toml')).not.toThrow()
})

test("assertNoForbiddenFlags: cursor's own ways to say yes are all refused by name", () => {
  expect(() => assertNoForbiddenFlags(['--force'], 'config.toml')).toThrow('--force')
  expect(() => assertNoForbiddenFlags(['--yolo'], 'config.toml')).toThrow('--yolo')
  // --mode is cursor's own floor flag, refused because cursor's launch
  // prepends it -- not by a blacklist entry of its own.
  expect(() => assertNoForbiddenFlags(['--mode', 'ask'], 'config.toml')).toThrow('--mode')
})

// config.ts validates `argKeysAsFlags(args)` -- keys with no values beside
// them -- so a rule that decided on the following token would be reading the
// next KEY, or nothing at all. These two are refused on the key alone, in every
// spelling a config or a spec can reach this with.
test('assertNoForbiddenFlags: --sandbox and --permission-mode are refused by name, value or not', () => {
  for (const argv of [
    ['--sandbox'],
    ['--sandbox', 'enabled'],
    ['--sandbox=disabled'],
    ['--permission-mode'],
    ['--permission-mode', 'plan'],
    ['--permission-mode=bypassPermissions'],
    // The keys-only shape config.ts actually passes: two forbidden keys in a
    // row, where a value-reading rule would swallow the second as the first's
    // argument.
    ['--permission-mode', '--sandbox'],
  ]) {
    expect(() => assertNoForbiddenFlags(argv, 'config.toml')).toThrow(RX_DISSOLVES_FLOOR)
  }
})

test("loadConfig: an agentic engine's [engine.args] tools duplicate is rejected at real config parse", () => {
  const dir = mkdtempSync(join(TEST_ROOT, 'engined-agentic-floor-'))
  const configPath = join(dir, 'config.toml')
  writeFileSync(
    configPath,
    `
[[engine]]
id = "claude"
agent_version = "1.2.3"

  [engine.args]
  tools = "Bash,Write"
`,
  )

  expect(() => loadConfig(configPath)).toThrow(RX_TOOLS_FLAG)
})

function pinnedBunxView(argv: string[]) {
  return {
    command: argv[0],
    hasPin: argv.some((token) => token.includes(PIN)),
    hasLatest: argv.some((token) => token.includes('latest')),
  }
}

const PINNED_BUNX = { command: BUNX, hasPin: true, hasLatest: false }

test('buildArgv: command[0] is the given bunx path, and the pin appears literally rather than latest', () => {
  const argv = buildArgv({
    bunx: BUNX,
    agent: 'claude',
    agentVersion: PIN,
    args: {},
    mcpConfigPath: MCP_CONFIG_PATH,
  })

  expect(pinnedBunxView(argv)).toEqual(PINNED_BUNX)
})

test('buildArgv: the rendered config path is the value of --mcp-config, never a positional prompt', () => {
  const argv = buildArgv({
    bunx: BUNX,
    agent: 'claude',
    agentVersion: PIN,
    args: {},
    mcpConfigPath: MCP_CONFIG_PATH,
  })

  expect(argv).toContain('--strict-mcp-config')
  const pathIndex = argv.indexOf(MCP_CONFIG_PATH)
  expect(argv[pathIndex - 1]).toBe('--mcp-config')
})

test('buildArgv: an agent with resolveBinary skips bunx and the pin entirely, using the resolved path as argv[0]', () => {
  const cursor = agentCli('cursor')
  expect(cursor?.resolveBinary).toBeDefined()
  let resolved: string | undefined
  try {
    resolved = cursor?.resolveBinary?.()
  } catch {
    resolved = undefined
  }
  // Without a cursor install the failure must still be loud and specific, at
  // the buildArgv call site a real launch would hit -- never a silent fallback
  // to a bare "agent". With one, buildArgv must route through it rather than
  // bunx and the pin must never appear.
  let built: string[] | undefined
  let buildError: unknown
  try {
    built = buildArgv({
      bunx: BUNX,
      agent: 'cursor',
      agentVersion: PIN,
      args: {},
      mcpConfigPath: MCP_CONFIG_PATH,
    })
  } catch (err) {
    buildError = err
  }
  expect({
    routed: built?.[0],
    pinLeaked: built?.some((token) => token.includes(PIN)) ?? false,
    failedLoudly: buildError instanceof Error,
  }).toEqual({ routed: resolved, pinLeaked: false, failedLoudly: resolved === undefined })
})

test('renderEmptyMcpConfig: the file it names exists and holds an empty MCP configuration', () => {
  const path = renderEmptyMcpConfig()

  expect(existsSync(path)).toBe(true)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: {} })
})

test('parseEnvelope: is_error true is a failure even when the process exited 0', () => {
  const envelope = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    terminal_reason: 'api_error',
    result: 'Not logged in',
  })

  const outcome = parseEnvelope(envelope)

  expect(outcome.ok).toBe(false)
  expect(outcome.failure).toContain('api_error')
})

test('parseEnvelope: is_error false is a success', () => {
  const envelope = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'hi',
  })

  const outcome = parseEnvelope(envelope)

  expect(outcome.ok).toBe(true)
  expect(outcome.result).toBe('hi')
})

test('buildChildEnv: only the allowlisted keys survive — a planted secret in the parent never reaches the child', () => {
  const ambient = {
    HOME: '/home/engined',
    BUN_INSTALL: '/opt/bun',
    BUN_TMPDIR: '/var/lib/engined/tmp',
    GITHUB_TOKEN: 'ghp_leaked_repo_scope',
  }

  const childEnv = buildChildEnv(['HOME', 'BUN_INSTALL', 'BUN_TMPDIR'], ambient)

  expect(childEnv.HOME).toBe(ambient.HOME)
  expect(childEnv.BUN_INSTALL).toBe(ambient.BUN_INSTALL)
  expect(childEnv.BUN_TMPDIR).toBe(ambient.BUN_TMPDIR)
  expect('GITHUB_TOKEN' in childEnv).toBe(false)
  expect(Object.values(childEnv)).not.toContain(ambient.GITHUB_TOKEN)
})

function fakeSpawn(result: ExecResult): { spawn: AgenticSpawn; calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    spawn: (argv, opts) => {
      calls.push([argv, opts])
      return Promise.resolve(result)
    },
  }
}

/** A spawn whose stdout carries a real clean-success envelope, the shape every "does the argv/env look right" test launches against. */
function fakeOkSpawn(): { spawn: AgenticSpawn; calls: unknown[][] } {
  return fakeSpawn({
    stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
    stderr: '',
    exitCode: 0,
  })
}

/** A spawn whose stdout carries a real is_error envelope, the shape every "reported as a failure" test launches against. */
function fakeErrorEnvelopeSpawn(): { spawn: AgenticSpawn; calls: unknown[][] } {
  return fakeSpawn({
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
      result: 'Not logged in',
    }),
    stderr: '',
    exitCode: 0,
  })
}

/** The runAgentic call every test below makes, varied only by spawn and whichever field the test is exercising. */
function runAgenticFixture(
  spawn: AgenticSpawn,
  overrides: Partial<Parameters<typeof runAgentic>[0]> = {},
) {
  return runAgentic({
    agent: 'claude',
    agentVersion: PIN,
    args: {},
    envAllowlist: ['HOME'],
    workdir: TEST_ROOT,
    prompt: 'hello',
    bunx: BUNX,
    spawn,
    // The spawn is fake, so bwrap never runs: only the argv it would be handed is read.
    bwrap: '/usr/bin/bwrap',
    pasta: '/usr/bin/pasta',
    ...overrides,
  })
}

test('runAgentic refuses to launch without pasta, as without bwrap, and never spawns', async () => {
  const { spawn, calls } = fakeOkSpawn()
  const result = await runAgenticFixture(spawn, { pasta: null })
  expect(result).toMatchObject({ ok: false, envelopeFailure: false })
  expect(result.failure).toContain('install passt')
  expect(calls).toHaveLength(0)
})

test('runAgentic refuses a workdir that is the operator home', async () => {
  const { spawn, calls } = fakeOkSpawn()
  const result = await runAgenticFixture(spawn, { workdir: homedir() })
  expect(result).toMatchObject({
    status: 400,
    ok: false,
    envelopeFailure: false,
  })
  expect(result.failure).toContain('home')
  expect(calls).toHaveLength(0)
})

test('runAgentic: cursor refuses --force, --yolo, and --sandbox before any spawn', async () => {
  // `force: false` still names the key. argvFromArgs would emit nothing for
  // it, which is exactly the spelling a value-reading check would wave through.
  const cases: Record<string, unknown>[] = [
    { force: true },
    { yolo: true },
    { sandbox: 'disabled' },
    { force: false },
  ]
  for (const args of cases) {
    const calls: unknown[][] = []
    const spawn: AgenticSpawn = (argv, opts) => {
      calls.push([argv, opts])
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    }
    const flag = Object.keys(args)[0] ?? ''
    const result = await runAgenticFixture(spawn, { agent: 'cursor', args })
    expect(result).toMatchObject({
      status: 400,
      ok: false,
      envelopeFailure: false,
      failure: expect.stringContaining(`--${flag}`),
    })
    expect(result.version).toBeUndefined()
    expect(calls).toHaveLength(0)
  }
})

test('runAgentic: a final stdout chunk without a newline still reaches onDelta', async () => {
  const deltas: string[] = []
  const line =
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"tail"}}}'
  const spawn: AgenticSpawn = (_argv, opts) => {
    opts.onStdout?.(line)
    return Promise.resolve({
      stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
      stderr: '',
      exitCode: 0,
    })
  }

  await runAgenticFixture(spawn, {
    onDelta: (text) => {
      deltas.push(text)
    },
  })

  expect(deltas).toEqual(['tail'])
})

test('array content reaches the CLI as its text parts, never as "[object Object]"', () => {
  const { prompt } = promptsFromMessages({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image_url', image_url: { url: 'https://example/x.png' } },
        ],
      },
    ],
  })
  expect(prompt).toBe('describe this')
})

test('system chat messages reach claude through a file in launch HOME, not argv or stdin', async () => {
  const { prompt, systemPrompt } = promptsFromMessages({
    messages: [
      { role: 'system', content: '<rules>answer JSON</rules>' },
      { role: 'user', content: '{"contact":"B"}' },
    ],
  })
  const { spawn, calls } = fakeOkSpawn()
  let fromFile = ''
  const wrapped: AgenticSpawn = (launchArgv, launchOpts) => {
    const flag = launchArgv.indexOf('--append-system-prompt-file')
    const promptFile = launchArgv[flag + 1]
    if (typeof promptFile === 'string') {
      fromFile = readFileSync(promptFile, 'utf8')
    }
    return spawn(launchArgv, launchOpts)
  }

  await runAgenticFixture(wrapped, { prompt, systemPrompt })

  const [argv, opts] = calls[0] as [string[], { input: string }]
  expect(argv).not.toContain('<rules>answer JSON</rules>')
  expect(argv).toContain('--append-system-prompt-file')
  expect(fromFile).toBe('<rules>answer JSON</rules>')
  expect(opts.input).toBe('{"contact":"B"}')
  expect(opts.input).not.toContain('<rules>')
})

test('a system prompt with a NUL byte is refused before spawn', async () => {
  const { spawn, calls } = fakeOkSpawn()
  const result = await runAgenticFixture(spawn, { systemPrompt: 'a\0b' })
  expect(result).toMatchObject({ status: 400, ok: false, envelopeFailure: false })
  expect(calls).toHaveLength(0)
})

test("runAgentic: the child's stderr reaches neither the result nor the log", async () => {
  // A child that echoes its stdin is the whole risk: journald keeps whatever
  // lands there, and only the provenance line may describe an agentic call.
  const stderrText = 'hello: prompt echoed back by a noisy diagnostic'
  const { spawn } = fakeSpawn({
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'the answer',
    }),
    stderr: stderrText,
    exitCode: 0,
  })
  const written: string[] = []
  const realWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stderr.write

  let result: Awaited<ReturnType<typeof runAgentic>>
  try {
    result = await runAgenticFixture(spawn)
  } finally {
    process.stderr.write = realWrite
  }

  expect(written.join('')).toBe('')
  expect(JSON.stringify(result)).not.toContain(stderrText)
  expect(result.result).toBe('the answer')
})

test.each([
  ['absent', undefined],
  ['empty', ''],
])('runAgentic: workdir %s is 400 and never spawns', async (_label, workdir) => {
  const { spawn, calls } = fakeSpawn({ stdout: '{}', stderr: '', exitCode: 0 })

  const result = await runAgenticFixture(spawn, { workdir })

  expect(result.status).toBe(400)
  expect(calls.length).toBe(0)
})

test('runAgentic: a workdir absent from engined never spawns and names PrivateTmp', async () => {
  const { spawn, calls } = fakeOkSpawn()
  const workdir = join(TEST_ROOT, `missing-workdir-${crypto.randomUUID()}`)

  const result = await runAgenticFixture(spawn, { workdir })

  expect(result.status).toBe(400)
  expect(result.failure).toContain(`workdir ${workdir} does not exist for engined`)
  expect(result.failure).toContain('PrivateTmp')
  expect(calls).toHaveLength(0)
})

test('runAgentic: an agent without a research floor refuses before spawning', async () => {
  const { spawn, calls } = fakeOkSpawn()

  const result = await runAgenticFixture(spawn, { agent: 'opencode', research: true })

  expect(result.status).toBe(400)
  expect(result.failure).toContain('agent "opencode" does not support research mode')
  expect(calls).toHaveLength(0)
})

test('runAgentic: an is_error envelope with exit 0 is reported as a failure, not success', async () => {
  const { spawn } = fakeErrorEnvelopeSpawn()

  const result = await runAgenticFixture(spawn)

  expect(result.ok).toBe(false)
  expect(result.status).not.toBe(200)
})

test('runAgentic: the command bwrap runs resolves from the given bunx and the pin appears in argv, never latest', async () => {
  const { spawn, calls } = fakeOkSpawn()

  await runAgenticFixture(spawn)

  const [argv] = calls[0] as [string[], unknown]
  const bwrapAt = argv.indexOf('/usr/bin/bwrap')
  expect(bwrapAt).toBeGreaterThan(0)
  expect(pinnedBunxView(argv.slice(argv.indexOf('--', bwrapAt) + 1))).toEqual(PINNED_BUNX)
})

test('runAgentic: claude and cursor launch under bwrap with their argv floors intact', async () => {
  for (const [agent, floor] of [
    ['claude', AGENTIC_FLOOR],
    ['cursor', CURSOR_FLOOR],
  ] as const) {
    const { spawn, calls } = fakeOkSpawn()

    await runAgenticFixture(spawn, { agent, resolveBinary: () => '/usr/bin/true' })

    const [argv, opts] = calls[0] as [string[], { env: Record<string, string> }]
    const bwrapAt = argv.indexOf('/usr/bin/bwrap')
    const launched = argv.slice(argv.indexOf('--', bwrapAt) + 1)
    expect(argv.slice(bwrapAt + 1, bwrapAt + 4)).toEqual(['--ro-bind', '/', '/'])
    expect(launched.join(' ')).toContain(floor.join(' '))
    expect(requireEnv(opts.env, 'HOME')).toContain(`/agentic-home/${agent}/launch-`)
  }
})

test('runAgentic: claude and cursor refuse with no bwrap rather than run loose', async () => {
  for (const agent of ['claude', 'cursor']) {
    const { spawn, calls } = fakeOkSpawn()

    const result = await runAgenticFixture(spawn, {
      agent,
      bwrap: null,
      resolveBinary: () => '/usr/bin/true',
    })

    expect(result.status).toBe(503)
    expect(result.failure).toContain('needs bwrap')
    expect(calls).toHaveLength(0)
  }
})

test('runAgentic: --mcp-config in the spawned argv names a real file holding an empty MCP config', async () => {
  const { spawn, calls } = fakeOkSpawn()

  await runAgenticFixture(spawn)

  const [argv] = calls[0] as [string[], unknown]
  expect(argv).toContain('--strict-mcp-config')
  const flagIndex = argv.indexOf('--mcp-config')
  expect(flagIndex).toBeGreaterThan(-1)
  const path = argv[flagIndex + 1] as string
  expect(existsSync(path)).toBe(true)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: {} })
})

test('runAgentic: an envelope failure is flagged distinctly from a request-shape 400', async () => {
  const { spawn } = fakeErrorEnvelopeSpawn()

  const envelopeFailureResult = await runAgenticFixture(spawn)
  const workdirMissingResult = await runAgenticFixture(spawn, { workdir: undefined })

  expect(envelopeFailureResult.envelopeFailure).toBe(true)
  expect(workdirMissingResult.envelopeFailure).toBe(false)
})

test('runAgentic: extraEnv is set on the child alongside the allowlist and wins on a name collision', async () => {
  const { spawn, calls } = fakeOkSpawn()

  await runAgenticFixture(spawn, {
    ambientEnv: { HOME: '/home/engined' },
    extraEnv: { HOME: '/redirected', ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/' },
  })

  const [, opts] = calls[0] as [string[], { env: Record<string, string> }]
  expect(opts.env.HOME).toBe('/redirected')
  expect(opts.env.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding/')
})

test('runAgentic: opencode gets a fresh XDG home and its Bun cache behind a throwaway overlay', async () => {
  const { spawn, calls } = fakeSpawn({
    stdout: '{"type":"text","part":{"text":"ok"}}',
    stderr: '',
    exitCode: 0,
  })

  await runAgenticFixture(spawn, {
    agent: 'opencode',
    bwrap: '/usr/bin/bwrap',
    upstream: { baseUrl: 'http://127.0.0.1:3000/openai/v1', model: 'local' },
  })

  const [argv, opts] = calls[0] as [string[], { env: Record<string, string> }]
  const home = requireEnv(opts.env, 'HOME')
  const cache = requireEnv(opts.env, 'BUN_INSTALL')
  expect(opts.env.XDG_CONFIG_HOME).toBe(`${home}/config`)
  expect(opts.env.XDG_DATA_HOME).toBe(`${home}/data`)
  expect(opts.env.XDG_STATE_HOME).toBe(`${home}/state`)
  expect(cache).not.toContain('/launch-')
  // An overlay over the launch homes' parent would let one launch read another's in-progress home.
  expect(home.startsWith(`${cache}/`)).toBe(false)
  expect(cache.endsWith('/bun')).toBe(true)
  const cacheIndex = argv.indexOf(cache)
  expect(argv.slice(cacheIndex - 1, cacheIndex + 3)).toEqual([
    '--overlay-src',
    cache,
    '--tmp-overlay',
    cache,
  ])
  expect(argv).toContain('--tmpfs')
  expect(argv).toContain('/run')
})

test("runAgentic: a successful result's version is the pin that was launched, not read back from anywhere else", async () => {
  const { spawn } = fakeOkSpawn()

  const result = await runAgenticFixture(spawn)

  expect(result.version).toBe(PIN)
})

/** Reads the witness path back out of the hook the hook-silence probe planted, the way a hook that actually fired would target it. */
function witnessPathFromCwd(cwd: string): string | undefined {
  const settingsPath = join(cwd, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) {
    return
  }
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks: Record<string, { hooks: { command: string }[] }[] | undefined>
  }
  const command = settings.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command ?? ''
  return command.split('>>')[1]?.trim()
}

function cleanEnvelopeSpawn(onCwd?: (cwd: string) => void): AgenticSpawn {
  return (_argv, opts) => {
    onCwd?.(opts.cwd)
    return Promise.resolve({
      stdout: JSON.stringify({ is_error: false, result: 'hello' }),
      stderr: '',
      exitCode: 0,
    })
  }
}

/** Every probe test below wires the same engine and pin through buildAgenticProbeRunner, varying only the injected spawn. */
function runProbe(spawn: AgenticSpawn) {
  const runner = buildAgenticProbeRunner(BUNX, { spawn })
  return runner(PIN, 'claude')
}

test('buildAgenticProbeRunner: a clean completion under both probes yields ok -- no real spawn, only the injected fake', async () => {
  const cwds: string[] = []

  const outcome = await runProbe(cleanEnvelopeSpawn((cwd) => cwds.push(cwd)))

  expect(outcome).toEqual({ ok: true })
  expect(cwds).toHaveLength(2)
})

/** Runs the probe with the state dir at a scratch root holding one already-proved pin; `spawn` sees the shared cache path, the bwrap argv and env. */
async function probeWithSharedCache(
  spawn: (shared: string, argv: string[], env: Record<string, string>) => void,
  isError = false,
) {
  const root = makeTestRoot('engined-probe-cache-')
  const saved = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = root
  const shared = join(root, 'engined', 'bun-install')
  const other = join(shared, 'install', 'cache', '@anthropic-ai', 'claude-code@9.9.9@@@1')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'cli.js'), 'original')
  try {
    const outcome = await runProbe((argv, opts) => {
      spawn(shared, argv, opts.env)
      return Promise.resolve({
        stdout: JSON.stringify({ is_error: isError, result: 'hello' }),
        stderr: '',
        exitCode: 0,
      })
    })
    return { outcome, shared, other }
  } finally {
    if (saved === undefined) {
      delete process.env.XDG_STATE_HOME
    } else {
      process.env.XDG_STATE_HOME = saved
    }
  }
}

test('buildAgenticProbeRunner: the shared Bun cache is never bound writable, so another pin cannot be overwritten', async () => {
  const binds: string[] = []
  const { shared, other } = await probeWithSharedCache((_s, argv) => {
    argv.forEach((arg, i) => {
      if (arg === '--bind') {
        binds.push(argv[i + 1] ?? '')
      }
    })
  })
  expect(binds.some((src) => src === shared || src.startsWith(`${shared}/`))).toBe(false)
  expect(binds.some((src) => src.startsWith(`${shared}.probe-`))).toBe(true)
  expect(readFileSync(join(other, 'cli.js'), 'utf8')).toBe('original')
})

test('buildAgenticProbeRunner: a passed probe promotes only the new pin; a failed one promotes nothing', async () => {
  const fetch = (_shared: string, _argv: string[], env: Record<string, string>) => {
    const pkg = join(String(env.BUN_INSTALL), 'install', 'cache', '@anthropic-ai')
    mkdirSync(join(pkg, `claude-code@${PIN}@@@1`), { recursive: true })
    mkdirSync(join(pkg, 'claude-code@9.9.9@@@1'), { recursive: true })
    writeFileSync(join(pkg, 'claude-code@9.9.9@@@1', 'cli.js'), 'poisoned')
  }
  const newPin = (shared: string) =>
    join(shared, 'install', 'cache', '@anthropic-ai', `claude-code@${PIN}@@@1`)
  const passed = await probeWithSharedCache(fetch)
  expect(passed.outcome.ok).toBe(true)
  expect(existsSync(newPin(passed.shared))).toBe(true)
  expect(readFileSync(join(passed.other, 'cli.js'), 'utf8')).toBe('original')

  const failed = await probeWithSharedCache(fetch, true)
  expect(failed.outcome.ok).toBe(false)
  expect(existsSync(newPin(failed.shared))).toBe(false)
})

test('buildAgenticProbeRunner: a probe that throws becomes a failed outcome, never a rejection', async () => {
  // `Bun.spawn` throws outright on a missing binary, which is what a
  // `ENGINED_BWRAP` naming a bwrap this box does not have produces. A
  // rejection here is memoized by `engines.ts` in place of an outcome and
  // handed to every later poll, so the throw has to land as an outcome.
  const outcome = await runProbe(() => {
    throw new Error("ENOENT: no such file or directory, posix_spawn '/nonexistent/bwrap'")
  })

  expect(outcome).toMatchObject({
    ok: false,
    failedProbe: 'byte-identical',
    detail: expect.stringContaining('ENOENT'),
  })
})

test('buildAgenticProbeRunner: a completion that writes into the scratch worktree fails byte-identical, and the hook probe never runs', async () => {
  const calls: string[] = []
  const spawn: AgenticSpawn = (_argv, opts) => {
    calls.push(opts.cwd)
    writeFileSync(join(opts.cwd, 'proof.txt'), 'hello')
    return cleanEnvelopeSpawn()([], opts)
  }

  const outcome = await runProbe(spawn)

  expect(outcome).toMatchObject({
    ok: false,
    failedProbe: 'byte-identical',
    detail: expect.stringContaining('worktree changed: proof.txt'),
  })
  expect(calls).toHaveLength(1)
})

test('buildAgenticProbeRunner: a hook that actually fires fails no-hook-fires', async () => {
  const spawn: AgenticSpawn = (_argv, opts) => {
    const witness = witnessPathFromCwd(opts.cwd)
    if (witness !== undefined) {
      writeFileSync(witness, 'fired\n')
    }
    return cleanEnvelopeSpawn()([], opts)
  }

  const outcome = await runProbe(spawn)

  expect(outcome).toEqual({ ok: false, failedProbe: 'no-hook-fires' })
})

test('buildAgenticProbeRunner: an envelope failure fails byte-identical even with an untouched worktree', async () => {
  const spawn: AgenticSpawn = () => Promise.resolve({ stdout: 'not json', stderr: '', exitCode: 0 })

  const outcome = await runProbe(spawn)

  expect(outcome).toMatchObject({
    ok: false,
    failedProbe: 'byte-identical',
    detail: expect.stringContaining('launch answered 502'),
  })
})

/** Reads the witness path back out of the hook `plantCursorPromptHook` planted -- cursor's own `.cursor/hooks.json`, never claude's `.claude/settings.json`. */
function cursorWitnessPathFromCwd(cwd: string): string | undefined {
  const hooksPath = join(cwd, '.cursor', 'hooks.json')
  if (!existsSync(hooksPath)) {
    return
  }
  const hooks = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
    hooks: { beforeSubmitPrompt: { command: string }[] }
  }
  const command = hooks.hooks.beforeSubmitPrompt[0]?.command ?? ''
  return command.split('>>')[1]?.trim()
}

function cleanCursorSpawn(onCwd?: (cwd: string) => void): AgenticSpawn {
  return (_argv, opts) => {
    onCwd?.(opts.cwd)
    return Promise.resolve({
      stdout: '{"type":"result","subtype":"success","is_error":false,"result":"hello"}',
      stderr: '',
      exitCode: 0,
    })
  }
}

function runCursorProbe(spawn: AgenticSpawn) {
  // A fixed path: the fake spawn never execs it, and the real lookup would
  // fail on any machine without cursor installed.
  const runner = buildAgenticProbeRunner(BUNX, { spawn, resolveBinary: () => '/opt/cursor/agent' })
  return runner(PIN, 'cursor')
}

test("buildAgenticProbeRunner: cursor's own probes pass against a clean stream-json result", async () => {
  const outcome = await runCursorProbe(cleanCursorSpawn())

  expect(outcome).toEqual({ ok: true })
})

test('buildAgenticProbeRunner: a cursor hook that actually fires fails no-hook-fires, read from .cursor/hooks.json', async () => {
  const spawn: AgenticSpawn = (_argv, opts) => {
    const witness = cursorWitnessPathFromCwd(opts.cwd)
    if (witness !== undefined) {
      writeFileSync(witness, 'fired\n')
    }
    return cleanCursorSpawn()([], opts)
  }

  const outcome = await runCursorProbe(spawn)

  expect(outcome).toEqual({ ok: false, failedProbe: 'no-hook-fires' })
})

test('buildAgenticProbeRunner: a cursor request carrying --sandbox disabled fails the probe and never spawns', async () => {
  const calls: string[] = []
  const spawn: AgenticSpawn = () => {
    calls.push('spawned')
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
  }
  const runner = buildAgenticProbeRunner(BUNX, {
    spawn,
    resolveBinary: () => '/opt/cursor/agent',
    args: { sandbox: 'disabled' },
  })

  const outcome = await runner(PIN, 'cursor')

  expect(calls).toHaveLength(0)
  expect(outcome.ok).toBe(false)
  expect(outcome.failedProbe).toBe('byte-identical')
  const detail = outcome.detail ?? ''
  expect(detail).toContain('--sandbox')
  expect(detail).toContain('400')
})

test('buildAgenticProbeRunner: cursor writing into the scratch worktree fails byte-identical', async () => {
  const spawn: AgenticSpawn = (_argv, opts) => {
    writeFileSync(join(opts.cwd, 'proof.txt'), 'hello')
    return cleanCursorSpawn()([], opts)
  }

  const outcome = await runCursorProbe(spawn)

  expect(outcome).toMatchObject({
    ok: false,
    failedProbe: 'byte-identical',
    detail: expect.stringContaining('worktree changed'),
  })
})

/**
 * `defaultAgenticSpawn` against a REAL child process, not a fake -- the one
 * thing a fake can never prove. `/bin/sh -c "... & wait"` gives the wrapper
 * pid (`sh`) a distinct worker pid underneath it, the same shape `bunx`
 * has around `claude` (confirmed live against this box's real `bunx`
 * before writing the fix: it spawns the real binary as its own child, not
 * an exec-replacement, and a single-pid SIGKILL left that child running,
 * orphaned, with no pid left to reach it through). A rejected promise alone
 * proves nothing about the OS process -- the actual proof is the heartbeat
 * file the worker would keep appending to if it survived.
 */
test('defaultAgenticSpawn: aborting kills the real worker process, not just the wrapper -- verified by a heartbeat file, not by the rejection alone', async () => {
  const dir = mkdtempSync(join(TEST_ROOT, 'engined-agentic-kill-'))
  const heartbeat = join(dir, 'heartbeat')
  writeFileSync(heartbeat, '')
  const argv = [
    '/bin/sh',
    '-c',
    'while true; do date +%s%N >> "$HEARTBEAT_FILE"; sleep 0.05; done & wait',
  ]
  const controller = new AbortController()
  const promise = defaultAgenticSpawn(argv, {
    cwd: dir,
    env: { ...process.env, HEARTBEAT_FILE: heartbeat },
    input: '',
    signal: controller.signal,
  })

  const countLines = () => readFileSync(heartbeat, 'utf8').split('\n').filter(Boolean).length
  // Let the worker actually start writing before killing it.
  await Bun.sleep(300)
  expect(countLines()).toBeGreaterThan(0)

  controller.abort()
  await expect(promise).rejects.toThrow()

  // The rejection above proves the PROMISE settled -- it proves nothing
  // about the process. Two more samples, a beat apart: if the worker
  // survived, the count would still be climbing between them.
  await Bun.sleep(400)
  const justAfterKill = countLines()
  await Bun.sleep(400)
  const settled = countLines()

  expect(settled).toBe(justAfterKill)
}, 10_000)

/**
 * Real child, real pipe: proves stderr is trimmed as it is read rather than
 * buffered whole and truncated at the end, which a fake exec can't tell
 * apart from a real bound. 50 marked lines well past the capture window,
 * then a trailing marker only the tail would still carry.
 */
test('defaultAgenticSpawn: stderr is capped to its tail, earlier lines dropped', async () => {
  const dir = mkdtempSync(join(TEST_ROOT, 'engined-agentic-stderr-'))
  const argv = [
    '/bin/sh',
    '-c',
    'i=0; while [ $i -lt 50 ]; do printf "line-%03d-XXXXXXXXXXXXXXXXXXXXXXXXXX\\n" "$i" >&2; i=$((i+1)); done; printf "END-OF-RUN\\n" >&2',
  ]
  const result = await defaultAgenticSpawn(argv, { cwd: dir, env: {}, input: '' })

  expect(result.stderr.endsWith('END-OF-RUN\n')).toBe(true)
  expect(result.stderr).not.toContain('line-000-')
  // STDERR_TAIL_CHARS * 4, mirrored here since the constant is not exported.
  expect(result.stderr.length).toBeLessThanOrEqual(1200)
})

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]
  if (value === undefined) {
    throw new Error(`sandbox environment omitted ${key}`)
  }
  return value
}

test('runAgentic: a symlinked workdir is bound and used as cwd by its resolved path, so a flipped link cannot redirect the bind', async () => {
  const real = mkdtempSync(join(TEST_ROOT, 'real-workdir-'))
  const link = join(TEST_ROOT, `link-${crypto.randomUUID()}`)
  symlinkSync(real, link)
  const { spawn, calls } = fakeOkSpawn()

  await runAgenticFixture(spawn, { workdir: link })

  const [argv, opts] = calls[0] as [string[], { cwd: string }]
  expect(opts.cwd).toBe(realpathSync(real))
  expect(argv).toContain(realpathSync(real))
  expect(argv).not.toContain(link)
})

test('runAgentic: a symlink to a runtime directory is refused by what it resolves to', async () => {
  const link = join(TEST_ROOT, `run-link-${crypto.randomUUID()}`)
  symlinkSync('/run', link)
  const { spawn, calls } = fakeOkSpawn()

  const result = await runAgenticFixture(spawn, { workdir: link })

  expect(result.status).toBe(400)
  expect(calls).toHaveLength(0)
})

test('runAgentic: with pasta the sandbox gets a private netns that forwards only the door port', async () => {
  const { spawn, calls } = fakeOkSpawn()

  await runAgenticFixture(spawn, {
    pasta: '/usr/bin/pasta',
    extraEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:29200/engined/scoped', OTHER: 'x' },
  })

  const [argv] = calls[0] as [string[]]
  expect(argv.slice(0, 14)).toEqual([
    '/usr/bin/pasta',
    '-q',
    '--config-net',
    '--map-host-loopback',
    'none',
    '-t',
    'none',
    '-u',
    'none',
    '-U',
    'none',
    '-T',
    '29200',
    '--',
  ])
  expect(argv.slice(14, 16)).toEqual(['/bin/bash', '-c'])
  expect(argv).toContain('/usr/bin/bwrap')
})

test('loopbackPorts names only loopback URLs, with default ports', () => {
  expect(
    loopbackPorts([
      'http://localhost:1/x',
      'https://127.0.0.1/',
      'http://10.0.0.1:2/',
      'nope',
      undefined,
    ]),
  ).toEqual([1, 443])
})

test('pipedArgv leaves a non-pasta argv alone', () => {
  expect(pipedArgv(['/usr/bin/bwrap', 'x'])).toEqual(['/usr/bin/bwrap', 'x'])
})

// pasta drops socket stdio, which is what Bun hands a piped child; the real spawn has to still get stdin, stdout, stderr and the exit code through it.
test.skipIf(Bun.which('pasta') === null)(
  'defaultAgenticSpawn carries stdin, stdout, stderr and the exit code through pasta',
  async () => {
    const result = await defaultAgenticSpawn(
      [
        Bun.which('pasta') ?? '',
        '-q',
        '--config-net',
        '--',
        '/bin/bash',
        '-c',
        'read l; echo "out:$l"; echo err >&2; exit 7',
      ],
      { cwd: '/usr/share', env: { PATH: '/usr/bin' }, input: 'hello' } as Parameters<
        typeof defaultAgenticSpawn
      >[1],
    )
    expect(result.stdout).toBe('out:hello\n')
    expect(result.stderr).toContain('err')
    expect(result.exitCode).toBe(7)
  },
)
