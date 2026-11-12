/**
 * The tool half of the Cursor protocol: what this door asks cursor-agent to
 * run, and how the CLI's answers read back.
 *
 * The CLI executes every tool itself; the server only names the work.
 * `ExecServerMessage` carries the request and `ExecClientMessage` the result,
 * one oneof field per tool on each side, paired by field number.
 *
 * Field numbers are recovered from a pinned cursor-agent bundle, not from
 * guesswork.
 */

import {
  bytesField,
  cursorExecWire,
  decode,
  type Field,
  fieldBytes,
  fieldString,
  intField,
  message,
  stringField,
} from './cursorProto.ts'

/** `ExecServerMessage` / `ExecClientMessage` oneof field numbers, one per tool. */
const SHELL = 2
const WRITE = 3
const DELETE = 4
const GREP = 5
const READ = 7
const LS = 8

const EXEC_ID = 15

const {
  bool,
  parsing,
  grep: grepWire,
  shell: shellWire,
  read,
  write,
  ls,
  agent,
  tool,
} = cursorExecWire
const del = cursorExecWire.delete

/**
 * `ShellArgs.timeout` is MILLISECONDS. Sending seconds kills the command
 * almost immediately -- a 60 reads as 60ms and the CLI answers with a
 * SIGTERM failure whose `execution_time` is the only clue.
 */
const SHELL_TIMEOUT_MS = 120_000

/** A tool call's raw JSON arguments, read as the wire fields they become. */
type ToolArgs = Record<string, unknown>

const str = (args: ToolArgs, key: string): string | undefined =>
  typeof args[key] === 'string' ? args[key] : undefined
const num = (args: ToolArgs, key: string): number | undefined =>
  typeof args[key] === 'number' ? args[key] : undefined
const flag = (args: ToolArgs, key: string): boolean => args[key] === true
const list = (args: ToolArgs, key: string): string[] =>
  Array.isArray(args[key]) ? args[key].filter((v): v is string => typeof v === 'string') : []

/**
 * `ShellArgs.parsing_result` is required: without it the CLI runs nothing and
 * answers `spawn_error: "Parsing result is required"`. It wants the command
 * already split, which is what the CLI would otherwise have done itself.
 */
function parsingResult(command: string): Uint8Array {
  const parts = command.split(' ').filter((p) => p.length > 0)
  const name = parts[0] ?? command
  const executable = message(
    stringField(parsing.executableName, name),
    ...parts
      .slice(1)
      .map((arg) => bytesField(parsing.executableArg, stringField(parsing.executableName, arg))),
    stringField(parsing.commandText, command),
  )
  return message(
    intField(parsing.failed, bool.false),
    bytesField(parsing.executables, executable),
    intField(parsing.hasRedirects, bool.false),
    intField(parsing.hasCmdSubst, bool.false),
  )
}

function grepArgs(args: ToolArgs, path: string, execId: string): Uint8Array {
  const optStr = (key: string, field: number) => {
    const v = str(args, key)
    return v === undefined ? [] : [stringField(field, v)]
  }
  const optInt = (key: string, field: number) => {
    const v = num(args, key)
    return v === undefined ? [] : [intField(field, v)]
  }
  return message(
    stringField(grepWire.pattern, str(args, 'pattern') ?? ''),
    stringField(grepWire.path, path),
    ...optStr('glob', grepWire.glob),
    ...optStr('output_mode', grepWire.outputMode),
    ...optInt('context_before', grepWire.contextBefore),
    ...optInt('context_after', grepWire.contextAfter),
    ...optInt('context', grepWire.context),
    ...(flag(args, 'case_insensitive') ? [intField(grepWire.caseInsensitive, bool.true)] : []),
    ...optStr('type', grepWire.fileType),
    ...optInt('head_limit', grepWire.headLimit),
    ...(flag(args, 'multiline') ? [intField(grepWire.multiline, bool.true)] : []),
    ...optStr('sort', grepWire.sort),
    ...(flag(args, 'sort_ascending') ? [intField(grepWire.sortAsc, bool.true)] : []),
    stringField(grepWire.callId, execId),
    ...optInt('offset', grepWire.resultOffset),
  )
}

function argsFor(
  tool: string,
  args: ToolArgs,
  execId: string,
): { field: number; args: Uint8Array } | undefined {
  const path = str(args, 'path') ?? ''
  switch (tool) {
    case 'shell': {
      const command = str(args, 'command') ?? ''
      const description = str(args, 'description')
      return {
        field: SHELL,
        args: message(
          stringField(shellWire.command, command),
          stringField(shellWire.cwd, '.'),
          intField(shellWire.timeout, SHELL_TIMEOUT_MS),
          stringField(shellWire.execId, execId),
          bytesField(shellWire.parsingResult, parsingResult(command)),
          intField(shellWire.skipApproval, bool.true),
          ...(flag(args, 'background') ? [intField(shellWire.background, bool.true)] : []),
          ...(description === undefined ? [] : [stringField(shellWire.description, description)]),
        ),
      }
    }
    case 'read': {
      const offset = num(args, 'offset')
      const limit = num(args, 'limit')
      return {
        field: READ,
        args: message(
          stringField(read.path, path),
          stringField(read.execId, execId),
          ...(offset === undefined ? [] : [intField(shellWire.readOffset, offset)]),
          ...(limit === undefined ? [] : [intField(shellWire.readLimit, limit)]),
        ),
      }
    }
    case 'write':
      return {
        field: WRITE,
        args: message(
          stringField(write.path, path),
          stringField(write.content, str(args, 'content') ?? ''),
          stringField(write.execId, execId),
          intField(shellWire.writeReturnContent, bool.false),
        ),
      }
    case 'delete':
      return {
        field: DELETE,
        args: message(stringField(del.path, path), stringField(del.execId, execId)),
      }
    case 'grep':
      return { field: GREP, args: grepArgs(args, path, execId) }
    case 'ls':
      return {
        field: LS,
        args: message(
          stringField(ls.path, path),
          ...list(args, 'ignore').map((name) => stringField(ls.ignore, name)),
          stringField(ls.execId, execId),
        ),
      }
    default:
      return undefined
  }
}

/** `AgentServerMessage{2 exec_server_message{1 id, 15 exec_id, <tool> args}}`. */
export function execRequest(
  id: number,
  execId: string,
  tool: string,
  args: ToolArgs,
): Uint8Array | undefined {
  const built = argsFor(tool, args, execId)
  if (built === undefined) {
    return undefined
  }
  return bytesField(
    agent.serverExec,
    message(
      intField(agent.messageId, id),
      stringField(EXEC_ID, execId),
      bytesField(built.field, built.args),
    ),
  )
}

/**
 * `ShellResult` and friends are each a oneof of outcomes. Only the shapes
 * this door reports back to the model are read: what ran, what it printed,
 * and whether it worked.
 */
const SHELL_SUCCESS = 1
const SHELL_FAILURE = 2
const SHELL_SPAWN_ERROR = 5

export interface ToolOutcome {
  ok: boolean
  text: string
}

function readShell(result: Field[]): ToolOutcome {
  const success = fieldBytes(result, SHELL_SUCCESS)
  if (success !== undefined) {
    const f = decode(success)
    const stdout = fieldString(f, shellWire.stdout) ?? ''
    const stderr = fieldString(f, shellWire.stderr) ?? ''
    return {
      ok: true,
      text: [stdout, stderr].filter((s) => s.length > 0).join('\n') || '(no output)',
    }
  }
  const failure = fieldBytes(result, SHELL_FAILURE)
  if (failure !== undefined) {
    const f = decode(failure)
    const signal = fieldString(f, shellWire.failSignal)
    const stderr = fieldString(f, shellWire.stderr) ?? ''
    return { ok: false, text: `command failed${signal ? ` (${signal})` : ''}: ${stderr}`.trim() }
  }
  const spawn = fieldBytes(result, SHELL_SPAWN_ERROR)
  if (spawn !== undefined) {
    return {
      ok: false,
      text: fieldString(decode(spawn), shellWire.spawnErrorText) ?? 'spawn error',
    }
  }
  return { ok: false, text: 'unrecognised shell result' }
}

/**
 * Each tool answers with its own result message, and the success payload's
 * useful field differs per tool -- `ReadSuccess` puts the path at field 1 and
 * the content at 2, so a generic "first field" read hands the model a
 * filename where it asked for a file.
 */
const SUCCESS = 1

/** Field carrying the answer inside each tool's success message. */
const SUCCESS_TEXT: Record<number, number> = {
  [READ]: 2, // ReadSuccess.content
  [WRITE]: 1, // WriteSuccess.path -- confirmation, the content came from us
  [DELETE]: 1, // DeleteSuccess.path
  [GREP]: 4, // GrepSuccess.workspace_results
  [LS]: 1, // LsSuccess.directory_tree_root
}

/** Every tool's second oneof slot is its error, and each carries the text at field 2. */
const ERROR_TEXT = 2

function readTool(field: number, result: Field[]): ToolOutcome {
  const success = fieldBytes(result, SUCCESS)
  if (success !== undefined) {
    const want = SUCCESS_TEXT[field] ?? 1
    const inner = decode(success)
    const text = fieldString(inner, want)
    if (text !== undefined && text.length > 0) {
      return { ok: true, text }
    }
    // An `ls` tree and a `grep` union are nested messages rather than a
    // plain string; their own first string is the useful line.
    const nested = fieldBytes(inner, want)
    return {
      ok: true,
      text:
        nested === undefined
          ? '(done)'
          : (fieldString(decode(nested), tool.nestedFirstString) ?? '(done)'),
    }
  }
  const failure = fieldBytes(result, tool.resultFailure)
  return {
    ok: false,
    text:
      failure === undefined
        ? 'tool failed'
        : (fieldString(decode(failure), ERROR_TEXT) ?? 'tool failed'),
  }
}

/**
 * Read one `AgentClientMessage{2 exec_client_message}` into the answer the
 * model is waiting for.
 */
export function execOutcome(execClient: Uint8Array): ToolOutcome {
  const fields = decode(execClient)
  const shellPayload = fieldBytes(fields, SHELL)
  if (shellPayload !== undefined) {
    return readShell(decode(shellPayload))
  }
  for (const field of [READ, WRITE, LS, GREP, DELETE]) {
    const raw = fieldBytes(fields, field)
    if (raw !== undefined) {
      return readTool(field, decode(raw))
    }
  }
  return { ok: false, text: 'no tool result in exec message' }
}

/**
 * `agent.v1.ToolCall` field per tool. This is a DIFFERENT message from the
 * `ExecServerMessage` oneof above -- exec runs the tool, `ToolCall` is what
 * the CLI renders -- and only the shell/ls/grep/delete variants happen to
 * carry the same arg message, so the rest are rebuilt here.
 */
const TOOL_CALL_FIELD: Record<string, number> = {
  shell: 1,
  delete: 3,
  grep: 5,
  read: 8,
  write: 12, // edit_tool_call: the CLI has no separate "write"
  ls: 13,
}

const TOOL_CALL_ID = 57

/**
 * The renderable form of a tool call. Sending only the exec message runs the
 * tool but leaves the CLI with nothing to show, so a transcript reads as bare
 * prose with invisible side effects.
 */
export function toolCallMessage(
  tool: string,
  toolArgs: ToolArgs,
  callId: string,
): Uint8Array | undefined {
  const field = TOOL_CALL_FIELD[tool]
  if (field === undefined) {
    return undefined
  }
  const path = str(toolArgs, 'path') ?? ''
  const args = (() => {
    switch (tool) {
      case 'shell': {
        const command = str(toolArgs, 'command') ?? ''
        return message(
          stringField(shellWire.command, command),
          stringField(shellWire.cwd, '.'),
          intField(shellWire.timeout, SHELL_TIMEOUT_MS),
          stringField(shellWire.execId, callId),
          bytesField(shellWire.parsingResult, parsingResult(command)),
        )
      }
      case 'read': // ReadToolArgs{1 path}
      case 'write': // EditArgs{1 path}
      case 'ls': // LsArgs{1 path}
      case 'delete': // DeleteArgs{1 path}
        return message(stringField(read.path, path))
      case 'grep': // GrepArgs{1 pattern, 2 path}
        return message(
          stringField(grepWire.pattern, str(toolArgs, 'pattern') ?? ''),
          stringField(grepWire.path, path),
        )
      default:
        return
    }
  })()
  if (args === undefined) {
    return undefined
  }
  return message(bytesField(field, message(bytesField(1, args))), stringField(TOOL_CALL_ID, callId))
}

/** The tool surface offered to the model, in OpenAI function-calling shape. */
export const TOOL_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Run a shell command in the workspace and return its output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          description: { type: 'string', description: 'What this command is for.' },
          background: {
            type: 'boolean',
            description: 'Leave it running and return immediately.',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file from the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer', description: 'First line to read, for a large file.' },
          limit: { type: 'integer', description: 'How many lines to read from offset.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Write a file in the workspace, replacing its contents.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ls',
      description: 'List a directory in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          ignore: { type: 'array', items: { type: 'string' }, description: 'Names to leave out.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search the workspace for a regular expression. Use glob to narrow a large repo.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          glob: { type: 'string', description: 'Only search files matching this glob.' },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: 'content returns matching lines; the others just locate them.',
          },
          context: { type: 'integer', description: 'Lines of context either side of a match.' },
          context_before: { type: 'integer' },
          context_after: { type: 'integer' },
          case_insensitive: { type: 'boolean' },
          type: { type: 'string', description: 'Restrict to a ripgrep file type, e.g. py.' },
          head_limit: { type: 'integer', description: 'Stop after this many results.' },
          multiline: { type: 'boolean', description: 'Let a pattern span lines.' },
          sort: {
            type: 'string',
            enum: ['none', 'path', 'modified', 'accessed', 'created'],
            description: 'Result order; defaults to modified.',
          },
          sort_ascending: { type: 'boolean' },
          offset: { type: 'integer', description: 'Skip this many results.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete',
      description: 'Delete a file from the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
] as const
