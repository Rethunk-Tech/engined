/**
 * The two envelope parsers, against output captured from the real binaries
 * rather than invented -- opencode 1.18.25 pointed at engined's own door, and
 * the same launch against a dead upstream for the failure shape.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pruneAgentInstallCaches } from './agentCaches.ts'
import { AGENT_PREPENDED_ARGV, AGENTIC_FLOOR, assertNoForbiddenFlags } from './agenticArgs.ts'
import {
  AGENT_IDS,
  agentCli,
  agentDelta,
  parseClaudeEnvelope,
  parseCursorEvents,
  parseOpencodeEvents,
  resolveCursorBinary,
  sweepOrphanOpencodeDirs,
} from './agents.ts'
import { makeTestRoot } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-agents-test-')

/** Captured verbatim: `opencode run --format json "Reply with exactly the word: pong"`. */
const OPENCODE_OK = [
  '{"type":"step_start","timestamp":1788076641319,"sessionID":"ses_x","part":{"id":"prt_a","messageID":"msg_a","sessionID":"ses_x","type":"step-start"}}',
  '{"type":"text","timestamp":1788076641743,"sessionID":"ses_x","part":{"id":"prt_b","messageID":"msg_a","sessionID":"ses_x","type":"text","text":"pong","time":{"start":1,"end":2}}}',
  '{"type":"step_finish","timestamp":1788076641743,"sessionID":"ses_x","part":{"id":"prt_c","reason":"stop","messageID":"msg_a","sessionID":"ses_x","type":"step-finish","tokens":{"total":11244,"input":11226,"output":18,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}',
].join('\n')

/** Captured verbatim against a port nothing was listening on. opencode also exited 1, which is not consulted. */
const OPENCODE_ERR =
  '{"type":"error","timestamp":1788076739979,"sessionID":"ses_y","error":{"name":"APIError","data":{"message":"Cannot connect to API: Unable to connect. Is the computer able to access the url?","isRetryable":true,"metadata":{"url":"http://127.0.0.1:29999/openai/v1/chat/completions"}}}}'

it("reads opencode's answer out of the text events, which arrive one per chunk", () => {
  expect(parseOpencodeEvents(OPENCODE_OK)).toEqual({
    ok: true,
    result: 'pong',
    // Straight off the captured step_finish part: `total` is already
    // `input + output` (11226 + 18 = 11244), so nothing here is engined's
    // own arithmetic. `cost` is 0 because this run answered on local llama.
    usage: {
      prompt_tokens: 11_226,
      completion_tokens: 18,
      total_tokens: 11_244,
      cost_usd: 0,
    },
  })
})

it('joins the text events in order rather than taking only the last', () => {
  const split = OPENCODE_OK.replace('"text":"pong"', '"text":"po"').concat(
    '\n',
    '{"type":"text","part":{"type":"text","text":"ng"}}',
  )
  expect(parseOpencodeEvents(split).result).toBe('pong')
})

it("reports the API error's own message, not the event name", () => {
  const out = parseOpencodeEvents(OPENCODE_ERR)
  expect(out.ok).toBe(false)
  expect(out.failure).toContain('Cannot connect to API')
})

it('an error event fails the call even when text was printed before it', () => {
  const out = parseOpencodeEvents(`${OPENCODE_OK}\n${OPENCODE_ERR}`)
  expect(out.ok).toBe(false)
  // The partial answer is still handed back, the way a claude envelope failure carries its result.
  expect(out.result).toBe('pong')
})

it('a stream that finished without an answer is a failure, not an empty success', () => {
  const noText = OPENCODE_OK.split('\n')
    .filter((l) => !l.includes('"type":"text"'))
    .join('\n')
  expect(parseOpencodeEvents(noText).ok).toBe(false)
})

it('stdout that is not events at all is a failure naming that, never a silent empty result', () => {
  expect(parseOpencodeEvents('').ok).toBe(false)
  expect(parseOpencodeEvents('Segmentation fault\n').failure).toContain('parseable JSON events')
})

it("claude's envelope still parses, and is_error still beats a populated result", () => {
  expect(parseClaudeEnvelope('{"result":"hi"}')).toEqual({ ok: true, result: 'hi' })
  const lying = parseClaudeEnvelope(
    '{"is_error":true,"subtype":"success","terminal_reason":"api_error","result":"Not logged in"}',
  )
  expect(lying.ok).toBe(false)
  expect(lying.failure).toContain('api_error')
})

/**
 * Captured from `claude -p --output-format json "Reply with exactly the word:
 * pong"` against 2.1.266, trimmed to the fields read here. The three-way
 * input split is exactly what the CLI reported for a four-token reply.
 */
const CLAUDE_OK_WITH_COST =
  '{"type":"result","subtype":"success","is_error":false,"result":"pong","usage":{"input_tokens":2,"cache_creation_input_tokens":21863,"cache_read_input_tokens":9869,"output_tokens":4},"total_cost_usd":0.2236745}'

it("claude's own cost figure is what an agentic attempt records", () => {
  const outcome = parseClaudeEnvelope(CLAUDE_OK_WITH_COST)

  expect(outcome.usage?.cost_usd).toBe(0.223_674_5)
  expect(outcome.usage?.completion_tokens).toBe(4)
  // Deliberately absent. 2 + 21863 + 9869 is not a prompt size worth charging
  // against -- the three bill at different rates -- and engined does not do
  // that addition on a provider's behalf. total_cost_usd is the answer.
  expect(outcome.usage?.prompt_tokens).toBeUndefined()
})

// A run that errored after spending still spent, so the figure has to survive
// the failure path rather than being dropped with the answer.
it('a failed claude envelope still reports what the failed run cost', () => {
  const failed = parseClaudeEnvelope(
    '{"is_error":true,"subtype":"error_during_execution","result":"","total_cost_usd":0.03}',
  )

  expect(failed.ok).toBe(false)
  expect(failed.usage?.cost_usd).toBe(0.03)
})

// An envelope stating nothing engined recognised reports no cost, rather than
// an object of absent fields that reads as a zero-cost run.
it('an envelope with no figures in it reports no usage at all', () => {
  expect(parseClaudeEnvelope('{"result":"hi"}').usage).toBeUndefined()
})

it('claude carries the read-only floor in its launch argv and opencode carries none', () => {
  const claude = agentCli('claude')
  const opencode = agentCli('opencode')
  expect(claude?.floor).toBe('flags')
  expect(claude?.launch('/mcp.json')).toEqual([
    '-p',
    '--output-format',
    'json',
    ...AGENTIC_FLOOR,
    '--mcp-config',
    '/mcp.json',
  ])
  // Not an oversight: opencode has no tool or permission flag to be given, so
  // its floor is the sandbox and its argv says nothing about one.
  expect(opencode?.floor).toBe('sandbox')
  expect(opencode?.launch('/mcp.json')).toEqual(['run', '--format', 'json'])
})

it('an unknown agent resolves to nothing, so the spec parser can refuse it by name', () => {
  expect(agentCli('codex')).toBeUndefined()
  expect(AGENT_IDS).toEqual(['claude', 'opencode', 'cursor'])
})

/**
 * Captured verbatim: `agent -p --output-format stream-json --mode ask
 * --trust "Say hello in one short sentence."` against 2026.08.28-50f0823,
 * logged in, trimmed to the lines the parser reads.
 */
const CURSOR_OK = [
  '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp/x","session_id":"s1","model":"Composer 2.5","permissionMode":"default"}',
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Say hello in one short sentence."}]},"session_id":"s1"}',
  '{"type":"thinking","subtype":"delta","text":"Preparing a brief greeting.","session_id":"s1"}',
  '{"type":"thinking","subtype":"completed","session_id":"s1"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello — good to meet you."}]},"session_id":"s1"}',
  '{"type":"result","subtype":"success","duration_ms":2458,"is_error":false,"result":"Hello — good to meet you.","session_id":"s1","request_id":"r1","usage":{"inputTokens":1,"outputTokens":1}}',
].join('\n')

it("reads cursor's answer out of the terminal result line, not the progress lines before it", () => {
  expect(parseCursorEvents(CURSOR_OK)).toEqual({
    ok: true,
    result: 'Hello — good to meet you.',
    // cursor spells them camelCase and states no cost. Its input side is one
    // number, unlike claude's, so it maps straight to `prompt_tokens`.
    usage: { prompt_tokens: 1, completion_tokens: 1, cost_usd: undefined },
  })
})

it('a stream with no result line is a failure, not a silent empty success', () => {
  const noResult = CURSOR_OK.split('\n')
    .filter((l) => !l.includes('"type":"result"'))
    .join('\n')
  const out = parseCursorEvents(noResult)
  expect(out.ok).toBe(false)
  expect(out.failure).toContain('parseable result')
})

it("stdout that is not events at all is a failure naming that -- the empty-stream non-result claude's own trap warns against", () => {
  expect(parseCursorEvents('').ok).toBe(false)
  expect(parseCursorEvents('Segmentation fault\n').failure).toContain('parseable result')
})

it("an in-stream is_error beats a populated result, the same as claude's own envelope", () => {
  const lying = parseCursorEvents(
    '{"type":"result","subtype":"error","is_error":true,"result":"partial"}',
  )
  expect(lying.ok).toBe(false)
  expect(lying.failure).toContain('error')
  expect(lying.result).toBe('partial')
})

it("cursor carries its own floor in argv -- a mode, not claude's tool allowlist -- and never touches AGENTIC_FLOOR", () => {
  const cursor = agentCli('cursor')
  expect(cursor?.floor).toBe('flags')
  expect(cursor?.wire).toBe('openai')
  expect(cursor?.launch('/mcp.json')).toEqual([
    '-p',
    '--output-format',
    'stream-json',
    '--mode',
    'ask',
    '--trust',
  ])
  expect(
    cursor?.launch('/mcp.json').some((tok) => (AGENTIC_FLOOR as readonly string[]).includes(tok)),
  ).toBe(false)
  // No `configure`: see src/agents.ts for why redirecting cursor's own
  // inference through engined's door is worse than leaving it alone.
  expect(cursor?.configure).toBeUndefined()
})

it("every flag an agent's own launch prepends is one no config can re-supply", () => {
  // The guard is derived from these same tables, so a flag added to any one of
  // them is unbeatable with no second edit anywhere. Read back off the launches
  // rather than off a written-down list, which is what would drift.
  for (const [id, agent] of [
    ['claude', agentCli('claude')],
    ['cursor', agentCli('cursor')],
  ] as const) {
    const prepended = agent?.launch('/mcp.json', true) ?? []
    const declared = new Set((AGENT_PREPENDED_ARGV[id] ?? []).flatMap((tokens) => [...tokens]))
    for (const flag of prepended.filter((tok) => tok.startsWith('--'))) {
      expect(declared.has(flag)).toBe(true)
      expect(() => assertNoForbiddenFlags([flag], 'config.toml')).toThrow(flag)
    }
  }
})

it('a config re-supplying --output-format to cursor is refused, silencing no stream-json evidence', () => {
  expect(() => assertNoForbiddenFlags(['--output-format'], 'config.toml')).toThrow(
    '--output-format',
  )
  expect(() => assertNoForbiddenFlags(['--output-format=text'], 'config.toml')).toThrow(
    '--output-format',
  )
})

it('cursor declares a binary resolution strategy; claude and opencode -- both npm-fetched by bunx -- declare none', () => {
  expect(agentCli('cursor')?.resolveBinary).toBeDefined()
  expect(agentCli('claude')?.resolveBinary).toBeUndefined()
  expect(agentCli('opencode')?.resolveBinary).toBeUndefined()
})

it('resolveCursorBinary: agent on PATH wins outright, the versions directory never consulted', () => {
  const resolved = resolveCursorBinary(
    (cmd) => (cmd === 'agent' ? '/home/x/.local/bin/agent' : null),
    '/nonexistent/versions/dir/never/read',
  )
  expect(resolved).toBe('/home/x/.local/bin/agent')
})

it('resolveCursorBinary: falls back to the newest versions directory by name when PATH has nothing', () => {
  const root = mkdtempSync(join(TEST_ROOT, 'cursor-versions-'))
  for (const version of ['2026.01.01-aaa', '2026.02.15-bbb', '2026.02.01-ccc']) {
    const dir = join(root, version)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cursor-agent'), '')
  }
  const resolved = resolveCursorBinary(() => null, root)
  expect(resolved).toBe(join(root, '2026.02.15-bbb', 'cursor-agent'))
})

it('resolveCursorBinary: neither PATH nor a versions directory has it -- throws naming both', () => {
  const root = mkdtempSync(join(TEST_ROOT, 'cursor-versions-empty-'))
  expect(() => resolveCursorBinary(() => null, root)).toThrow(root)
})

it('resolveCursorBinary: a versions directory that does not exist at all is treated the same as an empty one', () => {
  expect(() => resolveCursorBinary(() => null, '/nonexistent/engined-cursor-test')).toThrow('PATH')
})

describe('streamed deltas, per agent', () => {
  it('claude: partial-message text deltas are the answer as it prints; the result line still decides the verdict', () => {
    const lines = [
      '{"type":"system","subtype":"init"}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"po"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ng"}}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"pong"}',
    ]
    expect(lines.map((line) => agentDelta('claude', line)).join('')).toBe('pong')
    expect(parseClaudeEnvelope(lines.join('\n'))).toEqual({ ok: true, result: 'pong' })
    expect(parseClaudeEnvelope('{"is_error":false,"result":"pong"}')).toEqual({
      ok: true,
      result: 'pong',
    })
  })

  it('cursor: assistant text parts; opencode: text events; progress lines add nothing', () => {
    const cursor =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]}}'
    expect(agentDelta('cursor', cursor)).toBe('pong')
    expect(agentDelta('cursor', '{"type":"tool_call","subtype":"started"}')).toBe('')
    expect(agentDelta('opencode', '{"type":"text","part":{"text":"pong"}}')).toBe('pong')
    expect(agentDelta('opencode', '{"type":"step_start"}')).toBe('')
    expect(agentDelta('claude', 'not json')).toBe('')
  })
})

describe('orphan opencode config dirs', () => {
  it('removes agentic-opencode-* older than process start and leaves fresh dirs and every other name', () => {
    const root = makeTestRoot('engined-opencode-orphan-')
    const leak = join(root, 'agentic-opencode-leak')
    const fresh = join(root, 'agentic-opencode-fresh')
    mkdirSync(leak, { recursive: true })
    writeFileSync(join(leak, 'config.json'), '{}')
    mkdirSync(fresh, { recursive: true })
    writeFileSync(join(root, 'agentic-opencode.json'), '{}')
    mkdirSync(join(root, 'agentic-home'), { recursive: true })
    const pastSec = (performance.timeOrigin - 5000) / 1000
    utimesSync(leak, pastSec, pastSec)
    sweepOrphanOpencodeDirs(root)
    expect(existsSync(leak)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(join(root, 'agentic-opencode.json'))).toBe(true)
    expect(existsSync(join(root, 'agentic-home'))).toBe(true)
  })
})

function plantBunPackage(parent: string, base: string, version: string): void {
  mkdirSync(join(parent, `${base}@${version}@@@1`), { recursive: true })
  mkdirSync(join(parent, base), { recursive: true })
  writeFileSync(join(parent, base, `${version}@@@1`), '')
}

describe('agent install cache prune', () => {
  it('keeps the current pin of a package and removes only other versions of that package', () => {
    const root = makeTestRoot('engined-agent-cache-')
    const opencode = join(root, 'agentic-home', 'opencode', 'bun', 'install', 'cache')
    const claude = join(root, 'bun-install', 'install', 'cache', '@anthropic-ai')
    mkdirSync(join(opencode, '.tmp'), { recursive: true })
    writeFileSync(join(opencode, 'deadbeef.npm'), '')
    mkdirSync(join(opencode, 'unrelated@9.9.9@@@1'), { recursive: true })
    for (const base of [
      'opencode-ai',
      'opencode-linux-x64',
      'opencode-linux-x64-musl',
      'opencode-linux-x64-baseline',
      'opencode-linux-x64-baseline-musl',
    ]) {
      plantBunPackage(opencode, base, '1.18.25')
      plantBunPackage(opencode, base, '1.18.26')
    }
    for (const base of ['claude-code', 'claude-code-linux-x64', 'claude-code-linux-x64-musl']) {
      plantBunPackage(claude, base, '2.1.247')
      plantBunPackage(claude, base, '2.1.283')
    }
    pruneAgentInstallCaches('opencode', new Set(['1.18.26']), root)
    expect(existsSync(join(opencode, 'opencode-ai@1.18.26@@@1'))).toBe(true)
    expect(existsSync(join(opencode, 'opencode-ai', '1.18.26@@@1'))).toBe(true)
    expect(existsSync(join(opencode, 'opencode-linux-x64-musl@1.18.26@@@1'))).toBe(true)
    expect(existsSync(join(opencode, 'opencode-ai@1.18.25@@@1'))).toBe(false)
    expect(existsSync(join(opencode, 'opencode-ai', '1.18.25@@@1'))).toBe(false)
    expect(existsSync(join(opencode, 'opencode-linux-x64@1.18.25@@@1'))).toBe(false)
    expect(existsSync(join(opencode, 'unrelated@9.9.9@@@1'))).toBe(true)
    expect(existsSync(join(opencode, 'deadbeef.npm'))).toBe(true)
    expect(existsSync(join(opencode, '.tmp'))).toBe(true)
    expect(existsSync(join(claude, 'claude-code@2.1.247@@@1'))).toBe(true)
    pruneAgentInstallCaches('claude', new Set(['2.1.283']), root)
    expect(existsSync(join(claude, 'claude-code@2.1.283@@@1'))).toBe(true)
    expect(existsSync(join(claude, 'claude-code-linux-x64-musl@2.1.283@@@1'))).toBe(true)
    expect(existsSync(join(claude, 'claude-code@2.1.247@@@1'))).toBe(false)
    expect(existsSync(join(claude, 'claude-code-linux-x64@2.1.247@@@1'))).toBe(false)
  })

  it('keeps every pin of one agent and removes other versions', () => {
    const root = makeTestRoot('engined-agent-cache-pins-')
    const opencode = join(root, 'agentic-home', 'opencode', 'bun', 'install', 'cache')
    mkdirSync(opencode, { recursive: true })
    for (const version of ['1.18.25', '1.18.26', '1.18.27']) {
      plantBunPackage(opencode, 'opencode-ai', version)
    }
    pruneAgentInstallCaches('opencode', new Set(['1.18.26', '1.18.27']), root)
    expect(existsSync(join(opencode, 'opencode-ai@1.18.26@@@1'))).toBe(true)
    expect(existsSync(join(opencode, 'opencode-ai', '1.18.26@@@1'))).toBe(true)
    expect(existsSync(join(opencode, 'opencode-ai@1.18.27@@@1'))).toBe(true)
    expect(existsSync(join(opencode, 'opencode-ai', '1.18.27@@@1'))).toBe(true)
    expect(existsSync(join(opencode, 'opencode-ai@1.18.25@@@1'))).toBe(false)
    expect(existsSync(join(opencode, 'opencode-ai', '1.18.25@@@1'))).toBe(false)
  })
})
