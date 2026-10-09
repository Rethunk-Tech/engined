import { ParseError } from './errors/parse.ts'

/**
 * Prepended by engined in code on every agentic launch and removable by no
 * config entry or `spec_dir` override. Asserting `--safe-mode` alone is not
 * enough: neither the tool allowlist nor the MCP closure is sufficient by
 * itself, so all three are the floor.
 */
export const AGENTIC_FLOOR = [
  '--safe-mode',
  '--tools',
  'Read,Grep,Glob',
  '--strict-mcp-config',
] as const

/**
 * Not part of any safety floor -- needed only so stdout is the JSON the parser
 * expects. Unconditional in code on every call, the same as a floor: never
 * write `output-format` into a `[engine.args]` table.
 */
export const CLAUDE_OUTPUT_FORMAT = ['--output-format', 'json'] as const

/**
 * Names the empty config `--strict-mcp-config` holds claude to. Declared as
 * prepended so no config can name a second file and open the MCP door.
 */
export const CLAUDE_MCP_CONFIG_FLAG = ['--mcp-config'] as const

/** The streamed form: `stream-json` needs `--verbose` in print mode, and partial messages are what make it a stream of deltas rather than one chunk per turn. */
export const CLAUDE_STREAM_FORMAT = [
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
] as const

/**
 * `--output-format text` emits an empty stream on a refused write -- the tool
 * calls and the refusal itself are visible only in the `stream-json` event
 * log, so this is part of the floor's own evidence, not a preference.
 */
export const CURSOR_OUTPUT_FORMAT = ['--output-format', 'stream-json'] as const

/**
 * cursor's floor: a mode, not a tool allowlist. See docs/security-model.md: under `--mode plan` it read files and ran
 * read-only shell commands, but a write instruction produced no file and the
 * text "Plan mode blocks file writes", reaching for its plan tool instead --
 * unmoved by a permissive `.cursor/cli-config.json` planted in the workdir and
 * its parent. `--trust` carries no write capability of its own; without it a
 * fresh workdir's workspace-trust prompt refuses the launch outright before
 * plan mode is ever reached.
 */
export const CURSOR_FLOOR = ['--mode', 'plan', '--trust'] as const

/**
 * Everything engined itself prepends to an agentic launch, keyed by the agent
 * it is prepended for -- the read-only floor and the output format alike,
 * since a config that re-supplies either one reaches the child. Kept per
 * agent rather than merged into one array because where the floor comes from
 * is per-agent: claude's is argv, cursor's is a mode, and opencode's is the
 * bwrap mount table, which has no argv to name here at all.
 *
 * `agents.ts` composes each launch from exactly these.
 */
export const AGENT_PREPENDED_ARGV: Record<string, readonly (readonly string[])[]> = {
  claude: [CLAUDE_OUTPUT_FORMAT, CLAUDE_STREAM_FORMAT, AGENTIC_FLOOR, CLAUDE_MCP_CONFIG_FLAG],
  cursor: [CURSOR_OUTPUT_FORMAT, CURSOR_FLOOR],
}

/** Each dissolves the guarantee. Fatal at parse wherever they appear. */
export const FORBIDDEN_AGENTIC_FLAGS = [
  // opencode's own dangerous flag: "auto-approve permissions that are not
  // explicitly denied". It cannot reach the sandbox floor, but it hands an
  // agent shell and network without asking, so no agentic engine gets it.
  '--auto',
  '--add-dir',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-mode',
  // cursor's own two spellings of "run everything without asking" --
  // `--yolo` is documented as a bare alias for `--force`. Whether either
  // actually overrides `--mode plan` was never tested; the assertion costs
  // nothing either way, and cursor exposes more ways to say yes than claude
  // does.
  '--force',
  '--yolo',
  // cursor's own escape hatch from its sandbox. Only `disabled` dissolves
  // anything, but the config sites validate a KEY -- `argKeysAsFlags` renders
  // no values at all -- so a value-conditional refusal is a distinction the
  // caller structurally cannot make, and the one written here silently let
  // every value through. The key is the whole danger: engined decides this
  // posture, not a config.
  '--sandbox',
] as const

/**
 * Derived from `AGENT_PREPENDED_ARGV` itself rather than hand-copied: a config
 * `[engine.args]` key that renders to `--tools` (or any other prepended flag)
 * appends a SECOND copy after engined's own, and last-wins argument parsing
 * means whatever the config supplied is what the child actually gets — the
 * flag was never really prepended, just overwritten. Deriving means any flag
 * later added to any agent's own constants is automatically unbeatable too,
 * with nothing new to remember to blacklist.
 *
 * The blast radius differs per agent, which is why the format flags are in
 * here beside the floor: re-supplying `--output-format` to cursor silences the
 * `stream-json` event log that IS that floor's evidence (docs/security-model.md),
 * while on claude it only fails the envelope parser closed.
 *
 * Flattened across agents at the last step because the sites that ask cannot
 * know which agent they are asking for: a config names an engine, and the
 * agent id arrives later, out of that engine's spec.
 */
const AGENT_PREPENDED_FLAG_NAMES = new Set<string>(
  Object.values(AGENT_PREPENDED_ARGV).flatMap((groups) =>
    groups.flatMap((tokens) => tokens.filter((token) => token.startsWith('--'))),
  ),
)

/**
 * Every forbidden flag is forbidden by its name alone, and so is any flag
 * that duplicates one the floor itself sets. No value is consulted: the
 * config call sites hand this `argKeysAsFlags`, keys with no values at all,
 * so a rule that read `argv[i + 1]` would be reading the next KEY there and
 * would wave the flag through. A flag whose danger depends on its value is a
 * flag this function cannot honestly judge, so none is admitted.
 *
 * Throws `ParseError` naming the flag and the file.
 */
export function assertNoForbiddenFlags(argv: readonly string[], file: string): void {
  for (const arg of argv) {
    const bare = arg.split('=', 1)[0] ?? arg
    if ((FORBIDDEN_AGENTIC_FLAGS as readonly string[]).includes(bare)) {
      throw new ParseError(`${bare} dissolves the read-only floor`, file)
    }
    if (AGENT_PREPENDED_FLAG_NAMES.has(bare)) {
      throw new ParseError(
        `${bare} duplicates a flag engined prepends on every agentic launch; it cannot be overridden, only engined's own value would apply`,
        file,
      )
    }
  }
}

/**
 * The one way an args table becomes argv: `--key` for every entry, a bare flag
 * when the value is `true`, the stringified value otherwise, and nothing at all
 * when the value is `false`, `null` or `undefined` — a flag turned off is a flag
 * not passed, never `--key false`.
 */
export function argvFromArgs(args: Record<string, unknown>): string[] {
  const argv: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === false || value === null || value === undefined) {
      continue
    }
    argv.push(`--${key}`)
    if (value !== true) {
      argv.push(String(value))
    }
  }
  return argv
}

/**
 * Every key an args table declares, rendered as a flag regardless of its value.
 * The read-only floor is checked by KEY, so a flag written `= false` must still
 * be seen here — it is the value the floor refuses to let a config decide.
 */
export function argKeysAsFlags(args: Record<string, unknown>): string[] {
  return Object.keys(args).map((key) => `--${key}`)
}
