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

export interface ToolRequest {
  tool: 'shell' | 'read' | 'write' | 'delete' | 'grep' | 'ls'
  path?: string
  command?: string
  content?: string
  pattern?: string
  /** grep: restrict to matching files, the lever that makes it usable on a big repo. */
  glob?: string
  /** grep: `content` (default), `files_with_matches`, or `count` -- the client's own set. */
  outputMode?: string
  /** grep: lines of context either side of a match, or each side separately. */
  context?: number
  contextBefore?: number
  contextAfter?: number
  caseInsensitive?: boolean
  /** grep: ripgrep file type, e.g. `py`. */
  fileType?: string
  /** grep: stop after this many results. */
  headLimit?: number
  /** grep: let a pattern span lines. */
  multiline?: boolean
  /** grep: ripgrep sort key; `none` leaves ripgrep's own order. */
  sort?: string
  sortAscending?: boolean
  /** grep: skip this many results before returning any. */
  resultOffset?: number
  /** read: window into a large file, rather than pulling all of it into the turn. */
  offset?: number
  limit?: number
  /** ls: names to leave out of the listing. */
  ignore?: string[]
  /** shell: what the command is for, shown by the CLI beside the call. */
  description?: string
  /** shell: leave it running and return immediately. */
  background?: boolean
}

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

function grepArgs(req: ToolRequest, path: string, execId: string): Uint8Array {
  return message(
    stringField(grepWire.pattern, req.pattern ?? ''),
    stringField(grepWire.path, path),
    ...(req.glob === undefined ? [] : [stringField(grepWire.glob, req.glob)]),
    ...(req.outputMode === undefined ? [] : [stringField(grepWire.outputMode, req.outputMode)]),
    ...(req.contextBefore === undefined
      ? []
      : [intField(grepWire.contextBefore, req.contextBefore)]),
    ...(req.contextAfter === undefined ? [] : [intField(grepWire.contextAfter, req.contextAfter)]),
    ...(req.context === undefined ? [] : [intField(grepWire.context, req.context)]),
    ...(req.caseInsensitive ? [intField(grepWire.caseInsensitive, bool.true)] : []),
    ...(req.fileType === undefined ? [] : [stringField(grepWire.fileType, req.fileType)]),
    ...(req.headLimit === undefined ? [] : [intField(grepWire.headLimit, req.headLimit)]),
    ...(req.multiline ? [intField(grepWire.multiline, bool.true)] : []),
    ...(req.sort === undefined ? [] : [stringField(grepWire.sort, req.sort)]),
    ...(req.sortAscending ? [intField(grepWire.sortAsc, bool.true)] : []),
    stringField(grepWire.callId, execId),
    ...(req.resultOffset === undefined ? [] : [intField(grepWire.resultOffset, req.resultOffset)]),
  )
}

function argsFor(
  req: ToolRequest,
  execId: string,
): { field: number; args: Uint8Array } | undefined {
  const path = req.path ?? ''
  switch (req.tool) {
    case 'shell': {
      const command = req.command ?? ''
      return {
        field: SHELL,
        args: message(
          stringField(shellWire.command, command),
          stringField(shellWire.cwd, '.'),
          intField(shellWire.timeout, SHELL_TIMEOUT_MS),
          stringField(shellWire.execId, execId),
          bytesField(shellWire.parsingResult, parsingResult(command)),
          intField(shellWire.skipApproval, bool.true),
          ...(req.background ? [intField(shellWire.background, bool.true)] : []),
          ...(req.description === undefined
            ? []
            : [stringField(shellWire.description, req.description)]),
        ),
      }
    }
    case 'read':
      return {
        field: READ,
        args: message(
          stringField(read.path, path),
          stringField(read.execId, execId),
          ...(req.offset === undefined ? [] : [intField(shellWire.readOffset, req.offset)]),
          ...(req.limit === undefined ? [] : [intField(shellWire.readLimit, req.limit)]),
        ),
      }
    case 'write':
      return {
        field: WRITE,
        args: message(
          stringField(write.path, path),
          stringField(write.content, req.content ?? ''),
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
      return { field: GREP, args: grepArgs(req, path, execId) }
    case 'ls':
      return {
        field: LS,
        args: message(
          stringField(ls.path, path),
          ...(req.ignore ?? []).map((name) => stringField(ls.ignore, name)),
          stringField(ls.execId, execId),
        ),
      }
    default:
      return undefined
  }
}

/** `AgentServerMessage{2 exec_server_message{1 id, 15 exec_id, <tool> args}}`. */
export function execRequest(id: number, execId: string, req: ToolRequest): Uint8Array | undefined {
  const built = argsFor(req, execId)
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
export function toolCallMessage(req: ToolRequest, callId: string): Uint8Array | undefined {
  const field = TOOL_CALL_FIELD[req.tool]
  if (field === undefined) {
    return undefined
  }
  const path = req.path ?? ''
  const args = (() => {
    switch (req.tool) {
      case 'shell': {
        const command = req.command ?? ''
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
          stringField(grepWire.pattern, req.pattern ?? ''),
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
