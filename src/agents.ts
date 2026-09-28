/**
 * The agent CLIs engined can launch, and everything that differs between
 * them: which package `bunx` delivers, the argv that puts one in
 * non-interactive JSON mode, how its stdout reports success, and where its
 * read-only floor comes from.
 *
 * `agentic-cli` was written around `claude` alone, and the shape it assumed --
 * one print flag, one JSON envelope, a floor made of argv -- is not general.
 * `opencode`'s equivalent of `claude -p` is `opencode run`, but it prints a
 * stream of NDJSON events rather than an envelope, and it has no floor flag to
 * be given. Every one of those differences lives here so that nothing else has
 * to know which agent it is talking to.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AGENTIC_FLOOR,
  CLAUDE_MCP_CONFIG_FLAG,
  CLAUDE_OUTPUT_FORMAT,
  CLAUDE_STREAM_FORMAT,
  CURSOR_FLOOR,
  CURSOR_OUTPUT_FORMAT,
} from './agenticArgs.ts'
import { isUnder, stateDir } from './paths.ts'
import type { Usage } from './provenance.ts'
import { finiteNumber, isRecord, parseRecord } from './records.ts'
import type { Wire } from './types.ts'

export interface AgenticOutcome {
  ok: boolean
  result?: string
  failure?: string
  /** What this run cost, as the CLI itself reported it. Absent when its envelope stated nothing engined recognised. */
  usage?: Usage
}

/** The nested record at `key`, or `undefined` -- so a missing `usage`/`tokens` object reads as "reported nothing" rather than throwing. */
function recordAt(
  raw: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = raw?.[key]
  return isRecord(value) ? value : undefined
}

/** `undefined` rather than an object of all-absent fields: an envelope engined understood no figure in did not report a cost. */
export function usageOrUndefined(usage: Usage): Usage | undefined {
  return Object.values(usage).some((v) => v !== undefined) ? usage : undefined
}

/**
 * The accounting a claude-shaped `result` envelope carries. Both CLIs that
 * come through `envelopeOutcome` are read here, because they spell the same
 * two figures differently and neither spelling is a guess:
 *
 * - claude, captured from `-p --output-format json` against 2.1.266:
 *   `usage.output_tokens` (Anthropic's snake_case) and `total_cost_usd`.
 * - cursor, captured verbatim in `src/agents.test.ts`:
 *   `usage.inputTokens` / `usage.outputTokens`, and no cost at all.
 *
 * claude's `prompt_tokens` is deliberately absent while cursor's is not, and
 * the difference is real rather than an oversight. claude splits the input
 * side across `input_tokens`, `cache_creation_input_tokens` and
 * `cache_read_input_tokens` -- measured 2 / 21863 / 9869 on a four-token
 * reply -- and those three bill at different rates, so their sum is not a
 * prompt size anyone should charge against. `total_cost_usd` is the figure
 * that question does have an answer to, and claude states it outright.
 * cursor's `inputTokens` is one unambiguous number, so it maps straight.
 */
function envelopeUsage(envelope: Record<string, unknown>): Usage | undefined {
  const usage = recordAt(envelope, 'usage')
  return usageOrUndefined({
    prompt_tokens: finiteNumber(usage?.inputTokens),
    completion_tokens: finiteNumber(usage?.output_tokens) ?? finiteNumber(usage?.outputTokens),
    cost_usd: finiteNumber(envelope.total_cost_usd),
  })
}

/**
 * `flags` means the agent honours a read-only floor passed in argv and
 * `assertNoForbiddenFlags` keeps a config from unsaying it. `sandbox` means it
 * offers nothing argv can reach, so the floor is the mount table -- see
 * `sandbox.ts` for why that is the only honest option for such an agent.
 */
export type FloorKind = 'flags' | 'sandbox'

interface AgentCliCommon {
  id: string
  floor: FloorKind
  /**
   * The wire shape this agent's own process speaks -- what a redirected
   * upstream must also speak, since the door forwards it unchanged rather
   * than translating. Checked against `[[upstream]].wire` at registry
   * construction (`engines.ts`'s `checkAgenticWire`), never at config parse:
   * the agent id, and so this value, is not known until the spec loads.
   */
  wire: Wire
  /**
   * Argv between the pinned package and the operator's `[engine.args]`: the
   * print flag, the JSON format, and for a `flags` agent the floor itself.
   */
  launch: (
    mcpConfigPath: string,
    streaming?: boolean,
    systemPrompt?: string,
    research?: boolean,
  ) => string[]
  /** The only place this agent's success is decided. */
  parse: (stdout: string) => AgenticOutcome
  /** The answer text one stdout event adds, for a caller streaming the answer as it is produced; `""` for anything that is not answer text. */
  delta: (event: Record<string, unknown>) => string
  /**
   * Renders whatever this agent needs in order to be pointed at a model, and
   * returns the environment naming it plus a `cleanup` for whatever it wrote
   * — called once this launch's spawn has returned, win or lose, so a
   * per-launch file never outlives the process it was rendered for. Absent
   * for an agent that takes its upstream some other way -- claude's is a
   * base URL and a key in the env, already handled as a remote redirect.
   */
  configure?: (upstream: AgentTarget) => { env: Record<string, string>; cleanup: () => void }
}

/**
 * An agent either names an npm package -- `bunx <pkg>@<agentVersion>` fetches
 * and pins the binary in one step -- or resolves an already-installed binary
 * itself, never both. `resolveBinary`, present only for an agent with no npm
 * distribution at all, returns the absolute path to invoke instead, resolved
 * fresh on every call so a self-update between launches is picked up rather
 * than cached stale. Throws, naming what it looked for and where, rather than
 * ever falling back to a bare command name a spawned child's own (possibly
 * narrower) PATH might fail to find.
 */
export type AgentCli = AgentCliCommon &
  ({ pkg: string; resolveBinary?: undefined } | { pkg?: undefined; resolveBinary: () => string })

export interface AgentTarget {
  /** An OpenAI-compatible base, normally engined's own door. */
  baseUrl: string
  /** The model id at that base, e.g. `ornith`. */
  model: string
}

/**
 * Failure lives in the envelope, never in the exit code. Verified: `claude -p
 * --output-format json` exited 0 with `"subtype": "success"` and a non-empty
 * result while simultaneously carrying `is_error: true`, `terminal_reason:
 * "api_error"` and a body reading "Not logged in".
 */
export function parseClaudeEnvelope(stdout: string): AgenticOutcome {
  // `--output-format json` prints the envelope alone; `stream-json` prints
  // it as the last of many progress lines. Same fields either way.
  const envelope = eventOf(stdout) ?? lastResultLine(stdout)
  if (envelope === undefined) {
    return { ok: false, failure: 'claude did not print a parseable JSON envelope on stdout' }
  }
  return envelopeOutcome(envelope)
}

/** The verdict a claude-shaped `result` envelope carries; failure lives in `is_error`, never the exit code. */
function envelopeOutcome(envelope: Record<string, unknown>): AgenticOutcome {
  const result = typeof envelope.result === 'string' ? envelope.result : undefined
  // Carried on the failure path too: a run that errored after spending is a
  // run that spent, and dropping the figure there is how a month undercounts.
  const usage = envelopeUsage(envelope)
  if (envelope.is_error) {
    const reason =
      (typeof envelope.terminal_reason === 'string' ? envelope.terminal_reason : undefined) ??
      (typeof envelope.subtype === 'string' ? envelope.subtype : undefined) ??
      'is_error'
    return { ok: false, failure: `agentic envelope failure: ${reason}`, result, usage }
  }
  return { ok: true, result, usage }
}

/** The last `{"type":"result",...}` line of a stream-json log -- every line before it is progress and carries no verdict. */
function lastResultLine(stdout: string): Record<string, unknown> | undefined {
  let outcome: Record<string, unknown> | undefined
  for (const line of stdout.split('\n')) {
    const event = eventOf(line)
    if (event !== null && event.type === 'result') {
      outcome = event
    }
  }
  return outcome
}

/** Text a claude `stream-json` line adds to the answer: only partial-message content deltas, so a whole `assistant` message never repeats what its deltas already carried. */
function claudeDelta(event: Record<string, unknown>): string {
  if (event.type !== 'stream_event' || !isRecord(event.event)) {
    return ''
  }
  const inner = event.event
  if (inner.type !== 'content_block_delta' || !isRecord(inner.delta)) {
    return ''
  }
  return inner.delta.type === 'text_delta' && typeof inner.delta.text === 'string'
    ? inner.delta.text
    : ''
}

/** Text a cursor `stream-json` line adds to the answer: the text parts of each `assistant` message. */
function cursorDelta(event: Record<string, unknown>): string {
  if (
    event.type !== 'assistant' ||
    !isRecord(event.message) ||
    !Array.isArray(event.message.content)
  ) {
    return ''
  }
  return event.message.content
    .map((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '',
    )
    .join('')
}

/** What one line of `agentId`'s stdout adds to the streamed answer -- the empty string for progress, verdicts and noise. */
export function agentDelta(agentId: string, line: string): string {
  const event = eventOf(line)
  const agent = AGENTS[agentId]
  return event === null || agent === undefined ? '' : agent.delta(event)
}

/** `{"name":"APIError","data":{"message":"..."}}` -- the message where there is one, the name otherwise. */
function opencodeErrorMessage(error: unknown): string {
  if (!isRecord(error)) {
    return 'error'
  }
  if (isRecord(error.data) && typeof error.data.message === 'string') {
    return error.data.message
  }
  return typeof error.name === 'string' ? error.name : 'error'
}

/** One NDJSON line as an event, or `null` for a blank or unparseable one -- neither of which counts as an event. */
function eventOf(line: string): Record<string, unknown> | null {
  return line.trim() === '' ? null : parseRecord(line)
}

/** The answer an event carries, which is the empty string for every event that is not a text part. */
function answerTextOf(event: Record<string, unknown>): string {
  if (event.type !== 'text' || !isRecord(event.part) || typeof event.part.text !== 'string') {
    return ''
  }
  return event.part.text
}

/**
 * `opencode run --format json` prints one JSON object per line, not an
 * envelope: `step_start`, then a `text` event per chunk of answer, then
 * `step_finish`. A failure arrives as its own `{"type":"error"}` line carrying
 * an `APIError`, measured against a dead upstream.
 *
 * opencode does exit 1 on that failure where claude exits 0, but the exit code
 * is still not consulted -- an agent that reports failure in two places can
 * always report it in only one of them, and the stream is the one that also
 * carries the reason.
 *
 * opencode states its own accounting on the `step_finish` event's part,
 * captured from `opencode run --format json` (see `src/agents.test.ts`):
 * `tokens: {total, input, output, reasoning, cache: {...}}` and `cost`.
 *
 * Unlike claude's, the input side here is one number and `total` is already
 * `input + output` (measured 11226 + 18 = 11244), so all three map straight
 * across with no arithmetic of engined's own.
 */
function opencodeUsage(event: Record<string, unknown>): Usage | undefined {
  const part = recordAt(event, 'part')
  const tokens = recordAt(part, 'tokens')
  return usageOrUndefined({
    prompt_tokens: finiteNumber(tokens?.input),
    completion_tokens: finiteNumber(tokens?.output),
    total_tokens: finiteNumber(tokens?.total),
    cost_usd: finiteNumber(part?.cost),
  })
}

export function parseOpencodeEvents(stdout: string): AgenticOutcome {
  let text = ''
  let failure: string | undefined
  let events = 0
  let usage: Usage | undefined
  for (const line of stdout.split('\n')) {
    const event = eventOf(line)
    if (event === null) {
      continue
    }
    events += 1
    if (event.type === 'step_finish') {
      // A run of several steps ends on the last one's figures.
      usage = opencodeUsage(event) ?? usage
    }
    if (event.type === 'error') {
      // The first error is the cause; the ones after it are usually its wake.
      failure ??= opencodeErrorMessage(event.error)
    } else {
      text += answerTextOf(event)
    }
  }
  if (events === 0) {
    return { ok: false, failure: 'opencode did not print parseable JSON events on stdout' }
  }
  if (failure !== undefined) {
    return {
      ok: false,
      failure: `agentic event failure: ${failure}`,
      result: text === '' ? undefined : text,
      usage,
    }
  }
  if (text === '') {
    return { ok: false, failure: 'opencode finished without printing an answer', usage }
  }
  return { ok: true, result: text, usage }
}

/**
 * `stream-json` is one JSON object per line, and unlike opencode's stream it
 * ends with a single terminal `{"type":"result",...}` line carrying
 * `is_error`/`subtype`/`result` -- a claude-shaped envelope embedded as the
 * last of many progress lines (`thinking`, `tool_call`, `assistant`) rather
 * than the sole output. Every line before it is progress and carries no
 * verdict, so only the last `result` line found is read.
 */
export function parseCursorEvents(stdout: string): AgenticOutcome {
  const outcome = lastResultLine(stdout)
  if (outcome === undefined) {
    return { ok: false, failure: 'cursor did not print a parseable result on stdout' }
  }
  return envelopeOutcome(outcome)
}

/**
 * opencode is configured by file, not by flags, so engined writes the file.
 * It names an openai-compatible provider at the given base -- normally
 * engined's own door, which is what lets an opencode turn reach a local model
 * and still be accounted for like every other call through it.
 *
 * The `permission` and `tools` blocks are defence in depth and NOTHING MORE.
 * Measured: a project `opencode.json` in the workdir or any ancestor of it
 * overrides every one of them, because opencode's rules are last-wins. The
 * floor is `sandbox.ts`; this only closes the ordinary case where no such
 * file exists, and must never be described as what makes opencode safe.
 *
 * One `mkdtemp` directory per call, never a fixed filename: `upstream` carries
 * a launch-scoped door URL and model that differ on every call, and two
 * opencode launches in flight at once would otherwise share one file --
 * last write wins, so the loser's spawn reads a door URL or model that was
 * never its own. `cleanup` removes the directory once this launch's spawn
 * has returned, so a long-running daemon does not accumulate one directory
 * per call forever.
 */
function renderOpencodeConfig(upstream: AgentTarget): {
  env: Record<string, string>
  cleanup: () => void
} {
  mkdirSync(stateDir(), { recursive: true })
  const dir = mkdtempSync(join(stateDir(), 'agentic-opencode-'))
  const path = join(dir, 'config.json')
  writeFileSync(
    path,
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        engined: {
          npm: '@ai-sdk/openai-compatible',
          name: 'engined',
          // The door does not check a key on loopback, but the provider
          // package requires the field to be present at all.
          options: { baseURL: upstream.baseUrl, apiKey: 'unused' },
          models: { [upstream.model]: { name: upstream.model } },
        },
      },
      model: `engined/${upstream.model}`,
      permission: { '*': 'deny', edit: 'deny', bash: 'deny', webfetch: 'deny' },
      tools: { write: false, edit: false, patch: false, bash: false },
    }),
    'utf8',
  )
  return {
    env: { OPENCODE_CONFIG: path },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const OPENCODE_TEMP_PREFIX = 'agentic-opencode-'

/** Process start, so a later `AgenticGate` in this process cannot reap in-flight dirs. */
const PROCESS_STARTED_MS = performance.timeOrigin

/**
 * Per-call opencode config dirs live under `stateDir` as `agentic-opencode-*`.
 * `cleanup` removes the one it created; a process death mid-call does not.
 * Door startup sweeps leftover directories with this prefix, and only this
 * prefix, as direct children of the given root, and only when the directory's
 * mtime is older than this process's start.
 */
export function sweepOrphanOpencodeDirs(root: string = stateDir()): void {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(OPENCODE_TEMP_PREFIX)) {
      continue
    }
    const path = join(root, name)
    let mtimeMs: number
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      continue
    }
    if (mtimeMs >= PROCESS_STARTED_MS) {
      continue
    }
    if (!isUnder(root, path)) {
      continue
    }
    rmSync(path, { recursive: true, force: true })
  }
}

/**
 * Where cursor's own installer and self-updater keep every version it has
 * ever unpacked, newest last once sorted by name: `YYYY.MM.DD-hash`.
 *
 * `$HOME` literally, not `dataHome()`. This is cursor's directory, so the
 * base is whatever cursor's installer picked; routing it through engined's
 * own XDG resolution would point the lookup at engined's data root the
 * moment `XDG_DATA_HOME` is set and find nothing there. The opposite rule
 * from `config.ts`'s `~/.local/share/` prefix, which IS engined's own data.
 */
function cursorVersionsDir(): string {
  return join(homedir(), '.local/share/cursor-agent/versions')
}

/**
 * The two places cursor's own installer and self-updater ever put its
 * binary -- `agent` on PATH is what an operator's own shell already uses
 * (`~/.local/bin/agent`, a symlink into the versions directory below), and
 * the versions directory itself is the fallback for a shell whose PATH does
 * not carry that (a `--user` systemd unit, say). Never a third guess: an
 * absent binary throws, naming both places this looked, rather than
 * returning a bare "agent" a spawned child's own PATH might resolve to
 * nothing, or worse, to some other program.
 */
export function resolveCursorBinary(
  which: (cmd: string) => string | null = Bun.which,
  versionsDir: string = cursorVersionsDir(),
): string {
  const onPath = which('agent')
  if (onPath !== null) {
    return onPath
  }
  let versions: string[] = []
  try {
    versions = readdirSync(versionsDir).sort()
  } catch {
    // No installer directory either -- versions stays empty, and the
    // throw below reports both lookups failed.
  }
  const newest = versions.at(-1)
  const binary = newest === undefined ? undefined : join(versionsDir, newest, 'cursor-agent')
  if (binary !== undefined && existsSync(binary)) {
    return binary
  }
  throw new Error(
    `cursor's "agent" binary was not found on PATH or under ${versionsDir} -- install it with "curl https://cursor.com/install | bash"`,
  )
}

const AGENTS: Record<string, AgentCli> = {
  claude: {
    id: 'claude',
    pkg: '@anthropic-ai/claude-code',
    floor: 'flags',
    wire: 'anthropic',
    launch: (mcpConfigPath, streaming, systemPrompt, research) => [
      '-p',
      ...(streaming === true ? CLAUDE_STREAM_FORMAT : CLAUDE_OUTPUT_FORMAT),
      ...(research === true
        ? ['--safe-mode', '--tools', 'WebSearch,WebFetch', '--strict-mcp-config']
        : AGENTIC_FLOOR),
      ...(systemPrompt === undefined ? [] : ['--append-system-prompt', systemPrompt]),
      // --strict-mcp-config is a bare switch; a positional path would become the prompt.
      ...CLAUDE_MCP_CONFIG_FLAG,
      mcpConfigPath,
    ],
    parse: parseClaudeEnvelope,
    delta: claudeDelta,
  },
  opencode: {
    id: 'opencode',
    pkg: 'opencode-ai',
    floor: 'sandbox',
    wire: 'openai',
    // `-p` here would be `--password`. The print mode is the `run` subcommand.
    launch: () => ['run', '--format', 'json'],
    parse: parseOpencodeEvents,
    delta: answerTextOf,
    configure: renderOpencodeConfig,
  },
  cursor: {
    id: 'cursor',
    floor: 'flags',
    resolveBinary: resolveCursorBinary,
    // OpenRouter's own dedicated `/api/v1/cursor` endpoint describes itself
    // as normalizing cursor's own request shape "into the standard OpenAI
    // Chat Completions format" before it reaches a model -- the closest
    // available classification of the two this repo has. Nominal only: no
    // `configure` is declared below, so no route can actually reach it yet.
    wire: 'openai',
    // cursor has no config-path flag of its own -- `mcpConfigPath` is part
    // of every agent's `launch` signature but unused here.
    launch: () => ['-p', ...CURSOR_OUTPUT_FORMAT, ...CURSOR_FLOOR],
    parse: parseCursorEvents,
    delta: cursorDelta,
    // No `configure`: `CURSOR_API_KEY` is checked against Cursor's own key
    // format client-side before any network attempt -- measured against a
    // real OpenRouter key (rejected in ~0.4s, no connection made) and
    // against a Cursor-shaped placeholder pointed at an unreachable address
    // (a real connection attempt followed). No key this box holds passes
    // that check, so redirecting cursor's own inference through engined's
    // door here would turn every launch into a guaranteed failure, ambient
    // ones included -- worse than leaving it on its own login.
  },
}

export const AGENT_IDS = Object.keys(AGENTS)

/** `undefined` for a name no agent answers to, which the spec parser turns into a `ParseError`. */
export function agentCli(id: string): AgentCli | undefined {
  return AGENTS[id]
}
