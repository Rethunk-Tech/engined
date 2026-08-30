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
import { AGENTIC_FLOOR, isRecord } from "./types.ts";

export interface AgenticOutcome {
  ok: boolean;
  result?: string;
  failure?: string;
}

/**
 * `flags` means the agent honours a read-only floor passed in argv and
 * `assertNoForbiddenFlags` keeps a config from unsaying it. `sandbox` means it
 * offers nothing argv can reach, so the floor is the mount table -- see
 * `sandbox.ts` for why that is the only honest option for such an agent.
 */
export type FloorKind = "flags" | "sandbox";

export interface AgentCli {
  id: string;
  /** The npm package, without a version -- the pin is config, never code. */
  pkg: string;
  floor: FloorKind;
  /**
   * Argv between the pinned package and the operator's `[engine.args]`: the
   * print flag, the JSON format, and for a `flags` agent the floor itself.
   */
  launch: (mcpConfigPath: string) => string[];
  /** The only place this agent's success is decided. */
  parse: (stdout: string) => AgenticOutcome;
}

/**
 * Not part of any safety floor -- needed only so stdout is the JSON the parser
 * expects. Unconditional in code on every call, the same as a floor: never
 * write `output-format` into a `[engine.args]` table.
 */
const CLAUDE_OUTPUT_FORMAT = ["--output-format", "json"] as const;

/**
 * Failure lives in the envelope, never in the exit code. Verified: `claude -p
 * --output-format json` exited 0 with `"subtype": "success"` and a non-empty
 * result while simultaneously carrying `is_error: true`, `terminal_reason:
 * "api_error"` and a body reading "Not logged in".
 */
export function parseClaudeEnvelope(stdout: string): AgenticOutcome {
  let envelope: { is_error?: boolean; subtype?: string; terminal_reason?: string; result?: string };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { ok: false, failure: "claude did not print a parseable JSON envelope on stdout" };
  }
  if (envelope.is_error) {
    const reason = envelope.terminal_reason ?? envelope.subtype ?? "is_error";
    return { ok: false, failure: `agentic envelope failure: ${reason}`, result: envelope.result };
  }
  return { ok: true, result: envelope.result };
}

/** `{"name":"APIError","data":{"message":"..."}}` -- the message where there is one, the name otherwise. */
function opencodeErrorMessage(error: unknown): string {
  if (!isRecord(error)) {
    return "error";
  }
  if (isRecord(error.data) && typeof error.data.message === "string") {
    return error.data.message;
  }
  return typeof error.name === "string" ? error.name : "error";
}

/** One NDJSON line as an event, or `null` for a blank or unparseable one -- neither of which counts as an event. */
function eventOf(line: string): Record<string, unknown> | null {
  if (line.trim() === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/** The answer an event carries, which is the empty string for every event that is not a text part. */
function answerTextOf(event: Record<string, unknown>): string {
  if (event.type !== "text" || !isRecord(event.part) || typeof event.part.text !== "string") {
    return "";
  }
  return event.part.text;
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
 */
export function parseOpencodeEvents(stdout: string): AgenticOutcome {
  let text = "";
  let failure: string | undefined;
  let events = 0;
  for (const line of stdout.split("\n")) {
    const event = eventOf(line);
    if (event === null) {
      continue;
    }
    events += 1;
    if (event.type === "error") {
      // The first error is the cause; the ones after it are usually its wake.
      failure ??= opencodeErrorMessage(event.error);
    } else {
      text += answerTextOf(event);
    }
  }
  if (events === 0) {
    return { ok: false, failure: "opencode did not print parseable JSON events on stdout" };
  }
  if (failure !== undefined) {
    return {
      ok: false,
      failure: `agentic event failure: ${failure}`,
      result: text === "" ? undefined : text,
    };
  }
  if (text === "") {
    return { ok: false, failure: "opencode finished without printing an answer" };
  }
  return { ok: true, result: text };
}

const AGENTS: Record<string, AgentCli> = {
  claude: {
    id: "claude",
    pkg: "@anthropic-ai/claude-code",
    floor: "flags",
    launch: (mcpConfigPath) => ["-p", ...CLAUDE_OUTPUT_FORMAT, ...AGENTIC_FLOOR, mcpConfigPath],
    parse: parseClaudeEnvelope,
  },
  opencode: {
    id: "opencode",
    pkg: "opencode-ai",
    floor: "sandbox",
    // `-p` here would be `--password`. The print mode is the `run` subcommand.
    launch: () => ["run", "--format", "json"],
    parse: parseOpencodeEvents,
  },
};

export const AGENT_IDS = Object.keys(AGENTS);

/** `undefined` for a name no agent answers to, which the spec parser turns into a `ParseError`. */
export function agentCli(id: string): AgentCli | undefined {
  return AGENTS[id];
}
