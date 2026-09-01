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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths.ts";
import { AGENTIC_FLOOR, isRecord, type Wire } from "./types.ts";

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
   * The wire shape this agent's own process speaks -- what a redirected
   * upstream must also speak, since the door forwards it unchanged rather
   * than translating. Checked against `[[upstream]].wire` at registry
   * construction (`engines.ts`'s `checkAgenticWire`), never at config parse:
   * the agent id, and so this value, is not known until the spec loads.
   */
  wire: Wire;
  /**
   * Argv between the pinned package and the operator's `[engine.args]`: the
   * print flag, the JSON format, and for a `flags` agent the floor itself.
   */
  launch: (mcpConfigPath: string) => string[];
  /** The only place this agent's success is decided. */
  parse: (stdout: string) => AgenticOutcome;
  /**
   * Renders whatever this agent needs in order to be pointed at a model, and
   * returns the environment naming it. Absent for an agent that takes its
   * upstream some other way -- claude's is a base URL and a key in the env,
   * already handled as a remote redirect.
   */
  configure?: (upstream: AgentTarget) => Record<string, string>;
}

export interface AgentTarget {
  /** An OpenAI-compatible base, normally engined's own door. */
  baseUrl: string;
  /** The model id at that base, e.g. `ornith`. */
  model: string;
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

/**
 * `--output-format text` emits an empty stream on a refused write -- the tool
 * calls and the refusal itself are visible only in the `stream-json` event
 * log, so this is part of the floor's own evidence, not a preference.
 */
const CURSOR_OUTPUT_FORMAT = ["--output-format", "stream-json"] as const;

/**
 * cursor's floor: a mode, not a tool allowlist. Measured (docs/security-model.md)
 * against 2026.08.28-50f0823: under `--mode plan` it read files and ran
 * read-only shell commands, but a write instruction produced no file and the
 * text "Plan mode blocks file writes", reaching for its plan tool instead --
 * unmoved by a permissive `.cursor/cli-config.json` planted in the workdir and
 * its parent. `--trust` carries no write capability of its own; without it a
 * fresh workdir's workspace-trust prompt refuses the launch outright before
 * plan mode is ever reached.
 */
const CURSOR_FLOOR = ["--mode", "plan", "--trust"] as const;

/**
 * `stream-json` is one JSON object per line, and unlike opencode's stream it
 * ends with a single terminal `{"type":"result",...}` line carrying
 * `is_error`/`subtype`/`result` -- a claude-shaped envelope embedded as the
 * last of many progress lines (`thinking`, `tool_call`, `assistant`) rather
 * than the sole output. Every line before it is progress and carries no
 * verdict, so only the last `result` line found is read.
 */
export function parseCursorEvents(stdout: string): AgenticOutcome {
  let outcome: { is_error?: boolean; subtype?: string; result?: string } | undefined;
  for (const line of stdout.split("\n")) {
    const event = eventOf(line);
    if (event !== null && event.type === "result") {
      outcome = event as { is_error?: boolean; subtype?: string; result?: string };
    }
  }
  if (outcome === undefined) {
    return { ok: false, failure: "cursor did not print a parseable result on stdout" };
  }
  if (outcome.is_error) {
    return {
      ok: false,
      failure: `agentic envelope failure: ${outcome.subtype ?? "is_error"}`,
      result: outcome.result,
    };
  }
  return { ok: true, result: outcome.result };
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
 */
function renderOpencodeConfig(upstream: AgentTarget): Record<string, string> {
  const path = join(stateDir(), "agentic-opencode.json");
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: {
        engined: {
          npm: "@ai-sdk/openai-compatible",
          name: "engined",
          // The door does not check a key on loopback, but the provider
          // package requires the field to be present at all.
          options: { baseURL: upstream.baseUrl, apiKey: "unused" },
          models: { [upstream.model]: { name: upstream.model } },
        },
      },
      model: `engined/${upstream.model}`,
      permission: { "*": "deny", edit: "deny", bash: "deny", webfetch: "deny" },
      tools: { write: false, edit: false, patch: false, bash: false },
    }),
    "utf8",
  );
  return { OPENCODE_CONFIG: path };
}

const AGENTS: Record<string, AgentCli> = {
  claude: {
    id: "claude",
    pkg: "@anthropic-ai/claude-code",
    floor: "flags",
    wire: "anthropic",
    launch: (mcpConfigPath) => ["-p", ...CLAUDE_OUTPUT_FORMAT, ...AGENTIC_FLOOR, mcpConfigPath],
    parse: parseClaudeEnvelope,
  },
  opencode: {
    id: "opencode",
    pkg: "opencode-ai",
    floor: "sandbox",
    wire: "openai",
    // `-p` here would be `--password`. The print mode is the `run` subcommand.
    launch: () => ["run", "--format", "json"],
    parse: parseOpencodeEvents,
    configure: renderOpencodeConfig,
  },
  cursor: {
    id: "cursor",
    // Not yet fetchable this way: `bunx cursor-agent@<pin>` resolves to an
    // unrelated third-party npm package ("Task sequence creator for Cursor
    // AI agents", zalab-inc, versions 1.0.0-1.0.3 only) -- measured, and no
    // `@anysphere/cursor-agent` or `@cursor/cli` package exists either. The
    // real CLI ships only via Cursor's own installer into
    // `~/.local/share/cursor-agent/versions/<version>/`, self-updating with
    // no version-pinning subcommand. `buildArgv`'s shared launch has no path
    // that resolves this yet, so a real launch of this engine fails today --
    // this id is the target for whatever that resolution turns out to be.
    pkg: "cursor-agent",
    floor: "flags",
    // OpenRouter's own dedicated `/api/v1/cursor` endpoint describes itself
    // as normalizing cursor's own request shape "into the standard OpenAI
    // Chat Completions format" before it reaches a model -- the closest
    // available classification of the two this repo has. Nominal only: no
    // `configure` is declared below, so no route can actually reach it yet.
    wire: "openai",
    // cursor has no config-path flag of its own -- `mcpConfigPath` is part
    // of every agent's `launch` signature but unused here.
    launch: () => ["-p", ...CURSOR_OUTPUT_FORMAT, ...CURSOR_FLOOR],
    parse: parseCursorEvents,
    // No `configure`: `CURSOR_API_KEY` is checked against Cursor's own key
    // format client-side before any network attempt -- measured against a
    // real OpenRouter key (rejected in ~0.4s, no connection made) and
    // against a Cursor-shaped placeholder pointed at an unreachable address
    // (a real connection attempt followed). No key this box holds passes
    // that check, so redirecting cursor's own inference through engined's
    // door here would turn every launch into a guaranteed failure, ambient
    // ones included -- worse than leaving it on its own login.
  },
};

export const AGENT_IDS = Object.keys(AGENTS);

/** `undefined` for a name no agent answers to, which the spec parser turns into a `ParseError`. */
export function agentCli(id: string): AgentCli | undefined {
  return AGENTS[id];
}
