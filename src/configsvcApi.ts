/** The config half of the config UI's JSON API: reading, editing, validating, saving and reloading. */

import { configSchema } from './configSchema.ts'
import type { SecretTool } from './configsvcSecrets.ts'
import {
  listHistory,
  readHistory,
  readSnapshot,
  saveConfig,
  unifiedDiff,
} from './configsvcStore.ts'
import { checkConfigText, type ValidateEnv } from './configsvcValidate.ts'
import type { DoctorReport } from './doctor.ts'
import {
  jsonError,
  methodNotAllowed,
  readCappedText,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_CONFLICT,
  STATUS_NOT_FOUND,
  STATUS_UNPROCESSABLE,
} from './http.ts'
import { errMessage, isRecord, parseRecord } from './records.ts'
import { allowOf, dispatch, exactPath, pathPattern, type Route } from './routeTable.ts'
import { applyOps, dependents, type EditOp } from './tomlEdit.ts'

const HISTORY_ENTRY_RE = /^\/api\/history\/([^/]+)$/

const EDIT_OPS = new Set(['setKey', 'addEntry', 'removeEntry', 'renameId'])

export interface ConfigsvcDeps extends ValidateEnv {
  stateRoot: string
  /** engined's own base URL, read per request so a changed `listen_port` is followed. */
  doorUrl: () => string
  reload: (signal: 'HUP' | 'USR1') => Promise<{ ok: boolean; error?: string }>
  secrets: SecretTool
  audit: (line: string) => void
  fetch: typeof fetch
  doctor: () => Promise<DoctorReport>
}

export interface RequestInfo {
  client: string
}

export async function readJson(
  req: Request,
): Promise<Record<string, unknown> | Response | undefined> {
  const raw = await readCappedText(req)
  if (raw instanceof Response) {
    return raw
  }
  return parseRecord(raw) ?? undefined
}

const text = (body: Record<string, unknown>, key: string): string | undefined =>
  typeof body[key] === 'string' ? body[key] : undefined

function badRequest(message: string): Response {
  return jsonError(STATUS_BAD_REQUEST, message)
}

function editOps(value: unknown): EditOp[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value.every((op) => isRecord(op) && typeof op.op === 'string' && EDIT_OPS.has(op.op))
    ? (value as EditOp[])
    : undefined
}

function problemResponse(problem: unknown): Response {
  return Response.json({ ok: false, errors: [problem] }, { status: STATUS_UNPROCESSABLE })
}

function auditLine(info: RequestInfo, changed: string[], before: string, after: string): string {
  return `configsvc: audit ${new Date().toISOString()} client=${info.client} changed=${changed.join(',') || '-'} before=${before || '-'} after=${after}`
}

function save(deps: ConfigsvcDeps, info: RequestInfo, newText: string, base: string): Response {
  const outcome = saveConfig(deps, newText, base)
  if (outcome.ok) {
    deps.audit(auditLine(info, outcome.result.changed, outcome.before, outcome.result.sha256))
    return Response.json(outcome.result)
  }
  if (outcome.status === STATUS_CONFLICT) {
    return Response.json(
      { error: { message: 'config.toml changed on disk since it was read' }, ...outcome.current },
      { status: STATUS_CONFLICT },
    )
  }
  return problemResponse(outcome.checked.problem)
}

function restore(
  body: Record<string, unknown>,
  deps: ConfigsvcDeps,
  info: RequestInfo,
): Response | Promise<Response> {
  const name = text(body, 'name')
  const old = name === undefined ? undefined : readHistory(deps.configFile, name)
  return old === undefined
    ? jsonError(STATUS_NOT_FOUND, 'no such history entry')
    : save(deps, info, old, readSnapshot(deps.configFile).sha256)
}

async function reload(body: Record<string, unknown>, deps: ConfigsvcDeps): Promise<Response> {
  const signal = reloadSignal(body.mode)
  if (signal === undefined) {
    return badRequest('mode must be "hot" or "hard"')
  }
  const ran = await deps.reload(signal)
  return Response.json(ran, { status: ran.ok ? 200 : STATUS_BAD_GATEWAY })
}

function edit(body: Record<string, unknown>, candidate: string): Response {
  const ops = editOps(body.ops)
  if (ops === undefined) {
    return badRequest('"ops" must be a list of setKey, addEntry, removeEntry or renameId')
  }
  try {
    const edited = applyOps(candidate, ops)
    return Response.json({ text: edited, diff: unifiedDiff(candidate, edited) })
  } catch (err) {
    return problemResponse({ message: errMessage(err) })
  }
}

function historyEntry(name: string, deps: ConfigsvcDeps): Response {
  try {
    const old = readHistory(deps.configFile, name)
    return old === undefined
      ? jsonError(STATUS_NOT_FOUND, 'no such history entry')
      : Response.json({ name, text: old })
  } catch {
    return jsonError(STATUS_NOT_FOUND, 'no such history entry')
  }
}

function listDependents(body: Record<string, unknown>, candidate: string): Response {
  const table = text(body, 'table')
  const id = text(body, 'id')
  if (table === undefined || id === undefined) {
    return badRequest('"table" and "id" are required')
  }
  try {
    return Response.json({ dependents: dependents(candidate, table, id) })
  } catch (err) {
    return problemResponse({ message: errMessage(err) })
  }
}

function validate(candidate: string, deps: ConfigsvcDeps): Response {
  const checked = checkConfigText(candidate, deps)
  return Response.json({
    ok: checked.problem === undefined,
    errors: checked.problem ? [checked.problem] : [],
  })
}

interface ApiArgs {
  req: Request
  deps: ConfigsvcDeps
  info: RequestInfo
}
type BodyHandler = (
  body: Record<string, unknown>,
  deps: ConfigsvcDeps,
  info: RequestInfo,
) => Response | Promise<Response>

/** A POST route whose body must be a JSON object. */
function withBody(handler: BodyHandler): Route<ApiArgs>['handle'] {
  return async (_, { req, deps, info }) => {
    const body = await readJson(req)
    if (body instanceof Response) {
      return body
    }
    return body === undefined
      ? badRequest('the body must be a JSON object')
      : handler(body, deps, info)
  }
}

/** A POST route that also carries the candidate config `text`. */
function withCandidate(
  handler: (
    body: Record<string, unknown>,
    candidate: string,
    deps: ConfigsvcDeps,
    info: RequestInfo,
  ) => Response | Promise<Response>,
): Route<ApiArgs>['handle'] {
  return withBody((body, deps, info) => {
    const candidate = text(body, 'text')
    return candidate === undefined
      ? badRequest('"text" is required')
      : handler(body, candidate, deps, info)
  })
}

const getJson = (path: string, make: (deps: ConfigsvcDeps) => unknown): Route<ApiArgs> => ({
  methods: ['GET'],
  match: exactPath(path),
  handle: (_, { deps }) => Response.json(make(deps)),
})

const postRoute = (path: string, handle: Route<ApiArgs>['handle']): Route<ApiArgs> => ({
  methods: ['POST'],
  match: exactPath(path),
  handle,
})

const CONFIG_ROUTES: Route<ApiArgs>[] = [
  postRoute('/api/restore', withBody(restore)),
  postRoute(
    '/api/reload',
    withBody((body, deps) => reload(body, deps)),
  ),
  postRoute(
    '/api/validate',
    withCandidate((_, candidate, deps) => validate(candidate, deps)),
  ),
  postRoute(
    '/api/diff',
    withCandidate((_, candidate, deps) =>
      Response.json({ diff: unifiedDiff(readSnapshot(deps.configFile).text, candidate) }),
    ),
  ),
  postRoute(
    '/api/edit',
    withCandidate((body, candidate) => edit(body, candidate)),
  ),
  postRoute(
    '/api/dependents',
    withCandidate((body, candidate) => listDependents(body, candidate)),
  ),
  postRoute(
    '/api/save',
    withCandidate((body, candidate, deps, info) => {
      const base = text(body, 'base_sha256')
      return base === undefined
        ? badRequest('"base_sha256" is required')
        : save(deps, info, candidate, base)
    }),
  ),
  getJson('/api/config', (deps) => readSnapshot(deps.configFile)),
  getJson('/api/history', (deps) => ({ entries: listHistory(deps.configFile) })),
  getJson('/api/schema', () => configSchema()),
  {
    methods: ['GET'],
    match: pathPattern(HISTORY_ENTRY_RE),
    handle: ([entry = ''], { deps }) => historyEntry(decodeURIComponent(entry), deps),
  },
]

export function configApi(
  req: Request,
  path: string,
  deps: ConfigsvcDeps,
  info: RequestInfo,
): Response | Promise<Response> | undefined {
  const routed = dispatch(CONFIG_ROUTES, req.method, path, { req, deps, info })
  if (routed !== undefined) {
    return routed
  }
  const allow = allowOf(CONFIG_ROUTES, path)
  return allow.length > 0 ? methodNotAllowed(allow) : undefined
}

function reloadSignal(mode: unknown): 'HUP' | 'USR1' | undefined {
  if (mode === 'hot') {
    return 'HUP'
  }
  return mode === 'hard' ? 'USR1' : undefined
}
