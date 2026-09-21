/**
 * The tool half of the Cursor protocol: what this door asks cursor-agent to
 * run, and how the CLI's answers read back.
 *
 * The CLI executes every tool itself; the server only names the work.
 * `ExecServerMessage` carries the request and `ExecClientMessage` the result,
 * one oneof field per tool on each side, paired by field number.
 *
 * Field numbers come from `scripts/cursor-proto-extract.py` against a pinned
 * cursor-agent bundle, not from guesswork.
 */

import {
  bytesField,
  decode,
  type Field,
  fieldBytes,
  fieldString,
  intField,
  message,
  stringField,
} from "./cursorProto.ts";

/** `ExecServerMessage` / `ExecClientMessage` oneof field numbers, one per tool. */
const SHELL = 2;
const WRITE = 3;
const DELETE = 4;
const GREP = 5;
const READ = 7;
const LS = 8;

const EXEC_ID = 15;

/**
 * `ShellArgs.timeout` is MILLISECONDS. Sending seconds kills the command
 * almost immediately -- a 60 reads as 60ms and the CLI answers with a
 * SIGTERM failure whose `execution_time` is the only clue.
 */
const SHELL_TIMEOUT_MS = 120_000;

export interface ToolRequest {
  tool: "shell" | "read" | "write" | "delete" | "grep" | "ls";
  path?: string;
  command?: string;
  content?: string;
  pattern?: string;
  workdir?: string;
}

/**
 * `ShellArgs.parsing_result` is required: without it the CLI runs nothing and
 * answers `spawn_error: "Parsing result is required"`. It wants the command
 * already split, which is what the CLI would otherwise have done itself.
 */
function parsingResult(command: string): Uint8Array {
  const parts = command.split(" ").filter((p) => p.length > 0);
  const name = parts[0] ?? command;
  const executable = message(
    stringField(1, name),
    ...parts.slice(1).map((arg) => bytesField(2, stringField(1, arg))),
    stringField(3, command),
  );
  return message(
    intField(1, 0), // parsing_failed
    bytesField(2, executable), // executable_commands
    intField(3, 0), // has_redirects
    intField(4, 0), // has_command_substitution
  );
}

function argsFor(
  req: ToolRequest,
  execId: string,
): { field: number; args: Uint8Array } | undefined {
  const path = req.path ?? "";
  switch (req.tool) {
    case "shell": {
      const command = req.command ?? "";
      return {
        field: SHELL,
        args: message(
          stringField(1, command),
          stringField(2, req.workdir ?? "."),
          intField(3, SHELL_TIMEOUT_MS),
          stringField(4, execId),
          bytesField(8, parsingResult(command)),
          intField(12, 1), // skip_approval
        ),
      };
    }
    case "read":
      return { field: READ, args: message(stringField(1, path), stringField(2, execId)) };
    case "write":
      return {
        field: WRITE,
        args: message(
          stringField(1, path),
          stringField(2, req.content ?? ""),
          stringField(3, execId),
          intField(4, 0), // return_file_content_after_write
        ),
      };
    case "delete":
      return { field: DELETE, args: message(stringField(1, path), stringField(2, execId)) };
    case "grep":
      return {
        field: GREP,
        args: message(stringField(1, req.pattern ?? ""), stringField(2, path)),
      };
    case "ls":
      return { field: LS, args: message(stringField(1, path), stringField(3, execId)) };
    default:
      return undefined;
  }
}

/** `AgentServerMessage{2 exec_server_message{1 id, 15 exec_id, <tool> args}}`. */
export function execRequest(id: number, execId: string, req: ToolRequest): Uint8Array | undefined {
  const built = argsFor(req, execId);
  if (built === undefined) {
    return undefined;
  }
  return bytesField(
    2,
    message(intField(1, id), stringField(EXEC_ID, execId), bytesField(built.field, built.args)),
  );
}

/**
 * `ShellResult` and friends are each a oneof of outcomes. Only the shapes
 * this door reports back to the model are read: what ran, what it printed,
 * and whether it worked.
 */
const SHELL_SUCCESS = 1;
const SHELL_FAILURE = 2;
const SHELL_SPAWN_ERROR = 5;

export interface ToolOutcome {
  ok: boolean;
  text: string;
}

function readShell(result: Field[]): ToolOutcome {
  const success = fieldBytes(result, SHELL_SUCCESS);
  if (success !== undefined) {
    const f = decode(success);
    const stdout = fieldString(f, 5) ?? "";
    const stderr = fieldString(f, 6) ?? "";
    return {
      ok: true,
      text: [stdout, stderr].filter((s) => s.length > 0).join("\n") || "(no output)",
    };
  }
  const failure = fieldBytes(result, SHELL_FAILURE);
  if (failure !== undefined) {
    const f = decode(failure);
    const signal = fieldString(f, 4);
    const stderr = fieldString(f, 6) ?? "";
    return { ok: false, text: `command failed${signal ? ` (${signal})` : ""}: ${stderr}`.trim() };
  }
  const spawn = fieldBytes(result, SHELL_SPAWN_ERROR);
  if (spawn !== undefined) {
    return { ok: false, text: fieldString(decode(spawn), 3) ?? "spawn error" };
  }
  return { ok: false, text: "unrecognised shell result" };
}

/**
 * Each tool answers with its own result message, and the success payload's
 * useful field differs per tool -- `ReadSuccess` puts the path at field 1 and
 * the content at 2, so a generic "first field" read hands the model a
 * filename where it asked for a file.
 */
const SUCCESS = 1;

/** Field carrying the answer inside each tool's success message. */
const SUCCESS_TEXT: Record<number, number> = {
  [READ]: 2, // ReadSuccess.content
  [WRITE]: 1, // WriteSuccess.path -- confirmation, the content came from us
  [DELETE]: 1, // DeleteSuccess.path
  [GREP]: 4, // GrepSuccess.workspace_results
  [LS]: 1, // LsSuccess.directory_tree_root
};

/** Every tool's second oneof slot is its error, and each carries the text at field 2. */
const ERROR_TEXT = 2;

function readTool(field: number, result: Field[]): ToolOutcome {
  const success = fieldBytes(result, SUCCESS);
  if (success !== undefined) {
    const want = SUCCESS_TEXT[field] ?? 1;
    const inner = decode(success);
    const text = fieldString(inner, want);
    if (text !== undefined && text.length > 0) {
      return { ok: true, text };
    }
    // An `ls` tree and a `grep` union are nested messages rather than a
    // plain string; their own first string is the useful line.
    const nested = fieldBytes(inner, want);
    return {
      ok: true,
      text: nested === undefined ? "(done)" : (fieldString(decode(nested), 1) ?? "(done)"),
    };
  }
  const failure = fieldBytes(result, 2);
  return {
    ok: false,
    text:
      failure === undefined
        ? "tool failed"
        : (fieldString(decode(failure), ERROR_TEXT) ?? "tool failed"),
  };
}

/**
 * Read one `AgentClientMessage{2 exec_client_message}` into the answer the
 * model is waiting for.
 */
export function execOutcome(execClient: Uint8Array): ToolOutcome {
  const fields = decode(execClient);
  const shell = fieldBytes(fields, SHELL);
  if (shell !== undefined) {
    return readShell(decode(shell));
  }
  for (const field of [READ, WRITE, LS, GREP, DELETE]) {
    const raw = fieldBytes(fields, field);
    if (raw !== undefined) {
      return readTool(field, decode(raw));
    }
  }
  return { ok: false, text: "no tool result in exec message" };
}

/** The tool surface offered to the model, in OpenAI function-calling shape. */
export const TOOL_SCHEMA = [
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a shell command in the workspace and return its output.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write a file in the workspace, replacing its contents.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ls",
      description: "List a directory in the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search the workspace for a regular expression.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete",
      description: "Delete a file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
] as const;
