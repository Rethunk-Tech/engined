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
import { jsonError, STATUS_BAD_REQUEST, STATUS_CONFLICT, STATUS_NOT_FOUND } from './http.ts'
import { errMessage, isRecord } from './records.ts'
import { applyOps, type EditOp } from './tomlEdit.ts'

const STATUS_UNPROCESSABLE = 422
const STATUS_BAD_GATEWAY = 502
const CONFIG_POSTS = new Set([
  '/api/validate',
  '/api/edit',
  '/api/diff',
  '/api/save',
  '/api/restore',
  '/api/reload',
])
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

export async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await req.json()
    return isRecord(body) ? body : undefined
  } catch {
    return undefined
  }
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

async function save(
  deps: ConfigsvcDeps,
  info: RequestInfo,
  newText: string,
  base: string,
): Promise<Response> {
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
  const signal = body.mode === 'hot' ? 'HUP' : body.mode === 'hard' ? 'USR1' : undefined
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

function validate(candidate: string, deps: ConfigsvcDeps): Response {
  const checked = checkConfigText(candidate, deps)
  return Response.json({
    ok: checked.problem === undefined,
    errors: checked.problem ? [checked.problem] : [],
  })
}

async function configPost(
  path: string,
  req: Request,
  deps: ConfigsvcDeps,
  info: RequestInfo,
): Promise<Response> {
  const body = await readJson(req)
  if (body === undefined) {
    return badRequest('the body must be a JSON object')
  }
  if (path === '/api/restore') {
    return restore(body, deps, info)
  }
  if (path === '/api/reload') {
    return reload(body, deps)
  }
  const candidate = text(body, 'text')
  if (candidate === undefined) {
    return badRequest('"text" is required')
  }
  if (path === '/api/validate') {
    return validate(candidate, deps)
  }
  if (path === '/api/diff') {
    return Response.json({ diff: unifiedDiff(readSnapshot(deps.configFile).text, candidate) })
  }
  if (path === '/api/edit') {
    return edit(body, candidate)
  }
  const base = text(body, 'base_sha256')
  return base === undefined
    ? badRequest('"base_sha256" is required')
    : save(deps, info, candidate, base)
}

export function configApi(
  req: Request,
  path: string,
  deps: ConfigsvcDeps,
  info: RequestInfo,
): Response | Promise<Response> | undefined {
  if (req.method === 'POST') {
    return CONFIG_POSTS.has(path) ? configPost(path, req, deps, info) : undefined
  }
  if (req.method !== 'GET') {
    return undefined
  }
  if (path === '/api/config') {
    return Response.json(readSnapshot(deps.configFile))
  }
  if (path === '/api/history') {
    return Response.json({ entries: listHistory(deps.configFile) })
  }
  if (path === '/api/schema') {
    return Response.json(configSchema())
  }
  return undefined
}
