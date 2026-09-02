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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "./paths.ts";
import { AGENTIC_FLOOR, isRecord, parseRecord, type Wire } from "./types.ts";

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
  /**
   * The npm package, without a version -- the pin is config, never code.
   * For an agent declaring `resolveBinary` below, this is nominal only: kept
   * so `spec.ts`'s parse-time `command[1]` check still has a name to match
   * against, never used to build a real launch.
   */
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
  launch: (mcpConfigPath: string, streaming?: boolean) => string[];
  /** The only place this agent's success is decided. */
  parse: (stdout: string) => AgenticOutcome;
  /** The answer text one stdout event adds, for a caller streaming the answer as it is produced; `""` for anything that is not answer text. */
  delta: (event: Record<string, unknown>) => string;
  /**
   * Renders whatever this agent needs in order to be pointed at a model, and
   * returns the environment naming it plus a `cleanup` for whatever it wrote
   * — called once this launch's spawn has returned, win or lose, so a
   * per-launch file never outlives the process it was rendered for. Absent
   * for an agent that takes its upstream some other way -- claude's is a
   * base URL and a key in the env, already handled as a remote redirect.
   */
  configure?: (upstream: AgentTarget) => { env: Record<string, string>; cleanup: () => void };
  /**
   * Present only for an agent with no npm distribution at all -- absent
   * means today's path is unchanged: `bunx <pkg>@<agentVersion>` both
   * fetches and pins the binary in one step. Present, `bunx` never runs for
   * this agent; this returns the absolute path to invoke instead, resolved
   * fresh on every call so a self-update between launches is picked up
   * rather than cached stale. Throws, naming what it looked for and where,
   * rather than ever falling back to a bare command name a spawned child's
   * own (possibly narrower) PATH might fail to find.
   */
  resolveBinary?: () => string;
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
/** The streamed form: `stream-json` needs `--verbose` in print mode, and partial messages are what make it a stream of deltas rather than one chunk per turn. */
const CLAUDE_STREAM_FORMAT = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
] as const;

/**
 * Failure lives in the envelope, never in the exit code. Verified: `claude -p
 * --output-format json` exited 0 with `"subtype": "success"` and a non-empty
 * result while simultaneously carrying `is_error: true`, `terminal_reason:
 * "api_error"` and a body reading "Not logged in".
 */
export function parseClaudeEnvelope(stdout: string): AgenticOutcome {
  // `--output-format json` prints the envelope alone; `stream-json` prints
  // it as the last of many progress lines. Same fields either way.
  const envelope = eventOf(stdout) ?? lastResultLine(stdout);
  if (envelope === undefined) {
    return { ok: false, failure: "claude did not print a parseable JSON envelope on stdout" };
  }
  return envelopeOutcome(envelope);
}

/** The verdict a claude-shaped `result` envelope carries; failure lives in `is_error`, never the exit code. */
function envelopeOutcome(envelope: Record<string, unknown>): AgenticOutcome {
  const result = typeof envelope.result === "string" ? envelope.result : undefined;
  if (envelope.is_error) {
    const reason =
      (typeof envelope.terminal_reason === "string" ? envelope.terminal_reason : undefined) ??
      (typeof envelope.subtype === "string" ? envelope.subtype : undefined) ??
      "is_error";
    return { ok: false, failure: `agentic envelope failure: ${reason}`, result };
  }
  return { ok: true, result };
}

/** The last `{"type":"result",...}` line of a stream-json log -- every line before it is progress and carries no verdict. */
function lastResultLine(stdout: string): Record<string, unknown> | undefined {
  let outcome: Record<string, unknown> | undefined;
  for (const line of stdout.split("\n")) {
    const event = eventOf(line);
    if (event !== null && event.type === "result") {
      outcome = event;
    }
  }
  return outcome;
}

/** Text a claude `stream-json` line adds to the answer: only partial-message content deltas, so a whole `assistant` message never repeats what its deltas already carried. */
function claudeDelta(event: Record<string, unknown>): string {
  if (event.type !== "stream_event" || !isRecord(event.event)) {
    return "";
  }
  const inner = event.event;
  if (inner.type !== "content_block_delta" || !isRecord(inner.delta)) {
    return "";
  }
  return inner.delta.type === "text_delta" && typeof inner.delta.text === "string"
    ? inner.delta.text
    : "";
}

/** Text a cursor `stream-json` line adds to the answer: the text parts of each `assistant` message. */
function cursorDelta(event: Record<string, unknown>): string {
  if (
    event.type !== "assistant" ||
    !isRecord(event.message) ||
    !Array.isArray(event.message.content)
  ) {
    return "";
  }
  return event.message.content
    .map((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

/** What one line of `agentId`'s stdout adds to the streamed answer -- the empty string for progress, verdicts and noise. */
export function agentDelta(agentId: string, line: string): string {
  const event = eventOf(line);
  const agent = AGENTS[agentId];
  return event === null || agent === undefined ? "" : agent.delta(event);
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
  return line.trim() === "" ? null : parseRecord(line);
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
  const outcome = lastResultLine(stdout);
  if (outcome === undefined) {
    return { ok: false, failure: "cursor did not print a parseable result on stdout" };
  }
  return envelopeOutcome(outcome);
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
  env: Record<string, string>;
  cleanup: () => void;
} {
  mkdirSync(stateDir(), { recursive: true });
  const dir = mkdtempSync(join(stateDir(), "agentic-opencode-"));
  const path = join(dir, "config.json");
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
  return {
    env: { OPENCODE_CONFIG: path },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Where cursor's own installer and self-updater keep every version it has ever unpacked, newest last once sorted by name: `YYYY.MM.DD-hash`. */
function cursorVersionsDir(): string {
  return join(homedir(), ".local/share/cursor-agent/versions");
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
  const onPath = which("agent");
  if (onPath !== null) {
    return onPath;
  }
  let versions: string[] = [];
  try {
    versions = readdirSync(versionsDir).sort();
  } catch {
    // No installer directory either -- versions stays empty, and the
    // throw below reports both lookups failed.
  }
  const newest = versions.at(-1);
  const binary = newest === undefined ? undefined : join(versionsDir, newest, "cursor-agent");
  if (binary !== undefined && existsSync(binary)) {
    return binary;
  }
  throw new Error(
    `cursor's "agent" binary was not found on PATH or under ${versionsDir} -- install it with "curl https://cursor.com/install | bash"`,
  );
}

const AGENTS: Record<string, AgentCli> = {
  claude: {
    id: "claude",
    pkg: "@anthropic-ai/claude-code",
    floor: "flags",
    wire: "anthropic",
    launch: (mcpConfigPath, streaming) => [
      "-p",
      ...(streaming === true ? CLAUDE_STREAM_FORMAT : CLAUDE_OUTPUT_FORMAT),
      ...AGENTIC_FLOOR,
      mcpConfigPath,
    ],
    parse: parseClaudeEnvelope,
    delta: claudeDelta,
  },
  opencode: {
    id: "opencode",
    pkg: "opencode-ai",
    floor: "sandbox",
    wire: "openai",
    // `-p` here would be `--password`. The print mode is the `run` subcommand.
    launch: () => ["run", "--format", "json"],
    parse: parseOpencodeEvents,
    delta: answerTextOf,
    configure: renderOpencodeConfig,
  },
  cursor: {
    id: "cursor",
    // Nominal, for spec.ts's parse-time check only: `bunx cursor-agent@<pin>`
    // resolves to an unrelated third-party npm package ("Task sequence
    // creator for Cursor AI agents", zalab-inc, versions 1.0.0-1.0.3 only) --
    // measured, and no `@anysphere/cursor-agent` or `@cursor/cli` package
    // exists either. `resolveBinary` below is the real launch path.
    pkg: "cursor-agent",
    floor: "flags",
    resolveBinary: resolveCursorBinary,
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
};

export const AGENT_IDS = Object.keys(AGENTS);

/** `undefined` for a name no agent answers to, which the spec parser turns into a `ParseError`. */
export function agentCli(id: string): AgentCli | undefined {
  return AGENTS[id];
}
