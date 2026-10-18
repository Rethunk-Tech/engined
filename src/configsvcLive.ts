/** The half of the config UI's API that looks at the running system: engined's own endpoints, model files, the keyring. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { type ConfigsvcDeps, readJson } from './configsvcApi.ts'
import { listModelFiles, type ModelFile, memInfo } from './configsvcModelFile.ts'
import { shippedEngines } from './configsvcShipped.ts'
import {
  jsonError,
  methodNotAllowed,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_NOT_FOUND,
  STATUS_UNPROCESSABLE,
} from './http.ts'
import { runProbes } from './probe.ts'
import { errMessage, isRecord } from './records.ts'
import {
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_COMPLETIONS,
  CONTENT_ENDPOINT_EMBEDDINGS,
  CONTENT_ENDPOINT_IMAGE_EDITS,
  CONTENT_ENDPOINT_IMAGES,
  CONTENT_ENDPOINT_RERANK,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  CONTENT_ENDPOINT_TRANSLATIONS,
  OPENAI_MODELS_PATH,
} from './routeServes.ts'
import type { Config } from './types.ts'

const TEST_ROUTE_TIMEOUT_MS = 120_000
const ENGINE_VERB_RE = /^\/api\/(logs|resources)\/([^/]+)$/
const SPEC_RE = /^\/api\/spec\/([^/]+)$/
const OBTAIN_RE = /^\/api\/obtain\/([^/]+)$/

/** Streams engined's answer through, status and content type intact; a door that cannot be reached is a 502. */
async function proxy(deps: ConfigsvcDeps, path: string, init?: RequestInit): Promise<Response> {
  try {
    const upstream = await deps.fetch(`${deps.doorUrl()}${path}`, init)
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  } catch (err) {
    return jsonError(STATUS_BAD_GATEWAY, `engined could not be reached: ${errMessage(err)}`)
  }
}

function savedConfig(deps: ConfigsvcDeps): Config | Response {
  try {
    return loadConfig(deps.configFile, deps.enginesRoot)
  } catch (err) {
    return jsonError(STATUS_UNPROCESSABLE, `the saved config does not load: ${errMessage(err)}`)
  }
}

async function models(deps: ConfigsvcDeps): Promise<Response> {
  const config = savedConfig(deps)
  if (config instanceof Response) {
    return config
  }
  const engines: { engine: string; dir: string; files: ModelFile[] }[] = []
  for (const engine of config.engines) {
    if (engine.models_dir !== undefined) {
      engines.push({
        engine: engine.id,
        dir: engine.models_dir,
        files: await listModelFiles(engine.models_dir),
      })
    }
  }
  return Response.json({ engines, mem: memInfo() })
}

/** Shipped engines with the files already sitting in each one's default weights directory. */
async function shipped(deps: ConfigsvcDeps): Promise<Response> {
  const engines = await Promise.all(
    shippedEngines(deps.enginesRoot).map(async (engine) => ({
      ...engine,
      files: engine.models_path === undefined ? [] : await listModelFiles(engine.models_path),
    })),
  )
  return Response.json({ engines })
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** The caches engined keeps: each provider's model list and each upstream's inventory. Read-only. */
function discovery(deps: ConfigsvcDeps): Response {
  const read = (dir: string): string[] => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  const providers: Record<string, unknown> = {}
  for (const name of read(join(deps.stateRoot, 'models')).filter((n) => n.endsWith('.json'))) {
    providers[name.slice(0, -'.json'.length)] = readJsonFile(join(deps.stateRoot, 'models', name))
  }
  const inventories: Record<string, unknown> = {}
  for (const id of read(join(deps.stateRoot, 'upstreams'))) {
    inventories[id] = readJsonFile(join(deps.stateRoot, 'upstreams', id, 'inventory.json'))
  }
  return Response.json({ providers, inventories })
}

async function secrets(deps: ConfigsvcDeps): Promise<Response> {
  const config = savedConfig(deps)
  if (config instanceof Response) {
    return config
  }
  const refs = config.upstreams.flatMap((u) =>
    u.secret === undefined
      ? []
      : [{ upstream: u.id, service: u.secret.service, username: u.secret.username }],
  )
  const rows = await Promise.all(
    refs.map(async (ref) => ({
      ...ref,
      present: await deps.secrets.present(ref.service, ref.username),
    })),
  )
  return Response.json({ secrets: rows })
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''

async function storeSecret(req: Request, deps: ConfigsvcDeps): Promise<Response> {
  const body = await readJson(req)
  if (body instanceof Response) {
    return body
  }
  if (!(body && nonEmpty(body.service) && nonEmpty(body.username) && nonEmpty(body.value))) {
    return jsonError(STATUS_BAD_REQUEST, '"service", "username" and "value" are required strings')
  }
  const stored = await deps.secrets.store(body.service, body.username, body.value)
  return Response.json(stored.ok ? { ok: true } : { ok: false, error: stored.error }, {
    status: stored.ok ? 200 : STATUS_BAD_GATEWAY,
  })
}

async function clearSecret(req: Request, deps: ConfigsvcDeps): Promise<Response> {
  const body = await readJson(req)
  if (body instanceof Response) {
    return body
  }
  if (!(body && nonEmpty(body.service) && nonEmpty(body.username))) {
    return jsonError(STATUS_BAD_REQUEST, '"service" and "username" are required strings')
  }
  const cleared = await deps.secrets.clear(body.service, body.username)
  return Response.json(cleared.ok ? { ok: true } : { ok: false, error: cleared.error }, {
    status: cleared.ok ? 200 : STATUS_BAD_GATEWAY,
  })
}

interface RouteCheck {
  path: string
  body: string | FormData
  json: boolean
}

/** 0.5 s of 16 kHz mono 16-bit PCM silence: the smallest valid input a transcription verb accepts. */
function silentWav(): Blob {
  const samples = 8000
  const header = new DataView(new ArrayBuffer(44))
  const tag = (at: number, text: string) => {
    for (let i = 0; i < 4; i++) {
      header.setUint8(at + i, text.charCodeAt(i))
    }
  }
  tag(0, 'RIFF')
  header.setUint32(4, 36 + samples * 2, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, 1, true)
  header.setUint32(24, 16_000, true)
  header.setUint32(28, 32_000, true)
  header.setUint16(32, 2, true)
  header.setUint16(34, 16, true)
  tag(36, 'data')
  header.setUint32(40, samples * 2, true)
  return new Blob([header, new Uint8Array(samples * 2)], { type: 'audio/wav' })
}

/** The cheapest request the route answers, or undefined when every verb it serves is too costly to probe. */
function cheapCheck(model: string, serves: readonly string[]): RouteCheck | undefined {
  const json = (path: string, payload: Record<string, unknown>): RouteCheck => ({
    path,
    body: JSON.stringify({ model, ...payload }),
    json: true,
  })
  if (serves.includes(CONTENT_ENDPOINT_CHAT)) {
    return json(CONTENT_ENDPOINT_CHAT, {
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    })
  }
  if (serves.includes(CONTENT_ENDPOINT_COMPLETIONS)) {
    return json(CONTENT_ENDPOINT_COMPLETIONS, { prompt: 'ping', max_tokens: 1 })
  }
  if (serves.includes(CONTENT_ENDPOINT_EMBEDDINGS)) {
    return json(CONTENT_ENDPOINT_EMBEDDINGS, { input: 'ping' })
  }
  if (serves.includes(CONTENT_ENDPOINT_RERANK)) {
    return json(CONTENT_ENDPOINT_RERANK, { query: 'ping', documents: ['ping'] })
  }
  if (serves.includes(CONTENT_ENDPOINT_SPEECH)) {
    return { ...json(CONTENT_ENDPOINT_SPEECH, { input: 'ping' }), json: false }
  }
  const stt = serves.includes(CONTENT_ENDPOINT_TRANSCRIPTIONS)
    ? CONTENT_ENDPOINT_TRANSCRIPTIONS
    : serves.includes(CONTENT_ENDPOINT_TRANSLATIONS)
      ? CONTENT_ENDPOINT_TRANSLATIONS
      : undefined
  if (stt !== undefined) {
    const form = new FormData()
    form.set('model', model)
    form.set('file', silentWav(), 'ping.wav')
    return { path: stt, body: form, json: true }
  }
  return undefined
}

function skipReason(serves: readonly string[]): string {
  if (serves.some((p) => p === CONTENT_ENDPOINT_IMAGES || p === CONTENT_ENDPOINT_IMAGE_EDITS)) {
    return 'image routes have no cheap test: one would load the diffusion model'
  }
  const named = serves.length === 0 ? 'nothing' : serves.join(', ')
  return `${named} ha${serves.length === 1 || serves.length === 0 ? 's' : 've'} no cheap test`
}

/** What the running door says the address serves, or undefined when it does not list it. */
async function servedBy(deps: ConfigsvcDeps, address: string): Promise<string[] | undefined> {
  const res = await deps.fetch(`${deps.doorUrl()}${OPENAI_MODELS_PATH}`, {
    signal: AbortSignal.timeout(TEST_ROUTE_TIMEOUT_MS),
  })
  const listing: unknown = await res.json().catch(() => undefined)
  const rows = isRecord(listing) && Array.isArray(listing.data) ? listing.data : []
  const row = rows.find((r): r is Record<string, unknown> => isRecord(r) && r.id === address)
  return row !== undefined && Array.isArray(row.serves)
    ? row.serves.filter((p): p is string => typeof p === 'string')
    : undefined
}

async function testRoute(req: Request, deps: ConfigsvcDeps): Promise<Response> {
  const body = await readJson(req)
  if (body instanceof Response) {
    return body
  }
  if (!(body && nonEmpty(body.address) && body.address.startsWith('@/'))) {
    return jsonError(STATUS_BAD_REQUEST, '"address" must be an "@/..." route address')
  }
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  try {
    const serves = await servedBy(deps, body.address)
    if (serves === undefined) {
      return Response.json({
        status: 0,
        ms: elapsed(),
        error: 'not on the running door; save and reload first',
      })
    }
    const check = cheapCheck(body.address, serves)
    if (check === undefined) {
      return Response.json({ skipped: skipReason(serves) })
    }
    const res = await deps.fetch(`${deps.doorUrl()}${check.path}`, {
      method: 'POST',
      headers: typeof check.body === 'string' ? { 'content-type': 'application/json' } : {},
      body: check.body,
      signal: AbortSignal.timeout(TEST_ROUTE_TIMEOUT_MS),
    })
    const isJson = res.headers.get('content-type')?.includes('json') === true
    const answer: unknown =
      check.json || isJson ? await res.json().catch(() => undefined) : undefined
    const error =
      isRecord(answer) && isRecord(answer.error) ? String(answer.error.message) : undefined
    return Response.json({ status: res.status, ms: elapsed(), error })
  } catch (err) {
    return Response.json({ status: 0, ms: elapsed(), error: errMessage(err) })
  }
}

async function inventory(req: Request, deps: ConfigsvcDeps): Promise<Response> {
  const body = await readJson(req)
  if (body instanceof Response) {
    return body
  }
  if (!(body && nonEmpty(body.upstream))) {
    return jsonError(STATUS_BAD_REQUEST, '"upstream" is required')
  }
  return proxy(deps, `/engined/v1/upstreams/${encodeURIComponent(body.upstream)}/refresh`, {
    method: 'POST',
    signal: AbortSignal.any([req.signal, AbortSignal.timeout(TEST_ROUTE_TIMEOUT_MS)]),
  })
}

function specText(id: string, deps: ConfigsvcDeps): Response {
  const config = savedConfig(deps)
  if (config instanceof Response) {
    return config
  }
  const engine = config.engines.find((e) => e.id === id)
  if (engine === undefined) {
    return jsonError(STATUS_NOT_FOUND, `unknown engine "${id}"`)
  }
  try {
    const file = join(engine.spec_dir ?? join(deps.enginesRoot, engine.id), 'spec.toml')
    return Response.json({ engine: id, file, text: readFileSync(file, 'utf8') })
  } catch {
    return jsonError(STATUS_NOT_FOUND, `engine "${id}" has no spec.toml`)
  }
}

const PROXIED_GET: Record<string, string> = {
  '/api/status': '/engined/v1/engines',
  '/api/events': '/engined/v1/engines/events',
  '/api/usage': '/engined/v1/usage',
}
const LIVE_GET = new Set([
  ...Object.keys(PROXIED_GET),
  '/api/doctor',
  '/api/models',
  '/api/shipped',
  '/api/discovery',
  '/api/secrets',
])
const LIVE_POST = new Set([
  '/api/secret',
  '/api/secret/clear',
  '/api/test-route',
  '/api/inventory',
  '/api/probe',
])

function liveAllow(path: string): string[] {
  if (LIVE_POST.has(path) || OBTAIN_RE.test(path)) {
    return ['POST']
  }
  if (LIVE_GET.has(path) || ENGINE_VERB_RE.test(path) || SPEC_RE.test(path)) {
    return ['GET']
  }
  return []
}

export function liveApi(
  req: Request,
  path: string,
  deps: ConfigsvcDeps,
): Response | Promise<Response> | undefined {
  const allow = liveAllow(path)
  if (allow.length > 0 && !allow.includes(req.method)) {
    return methodNotAllowed(allow)
  }
  if (req.method === 'GET') {
    const target = PROXIED_GET[path]
    if (target !== undefined) {
      return proxy(deps, `${target}${new URL(req.url).search}`, { signal: req.signal })
    }
    const verb = ENGINE_VERB_RE.exec(path)
    if (verb !== null) {
      const id = encodeURIComponent(decodeURIComponent(verb[2] as string))
      return proxy(deps, `/engined/v1/engines/${id}/${verb[1]}${new URL(req.url).search}`, {
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(TEST_ROUTE_TIMEOUT_MS)]),
      })
    }
    const spec = SPEC_RE.exec(path)?.[1]
    if (spec !== undefined) {
      return specText(decodeURIComponent(spec), deps)
    }
    switch (path) {
      case '/api/doctor':
        return deps.doctor().then((report) => Response.json(report))
      case '/api/models':
        return models(deps)
      case '/api/shipped':
        return shipped(deps)
      case '/api/discovery':
        return discovery(deps)
      case '/api/secrets':
        return secrets(deps)
      default:
        return undefined
    }
  }
  if (req.method !== 'POST') {
    return undefined
  }
  const obtain = OBTAIN_RE.exec(path)?.[1]
  if (obtain !== undefined) {
    return proxy(
      deps,
      `/engined/v1/engines/${encodeURIComponent(decodeURIComponent(obtain))}/obtain`,
      {
        method: 'POST',
        signal: req.signal,
      },
    )
  }
  switch (path) {
    case '/api/secret':
      return storeSecret(req, deps)
    case '/api/secret/clear':
      return clearSecret(req, deps)
    case '/api/test-route':
      return testRoute(req, deps)
    case '/api/inventory':
      return inventory(req, deps)
    case '/api/probe':
      return runProbes(deps.doorUrl(), deps.fetch).then((report) => Response.json(report))
    default:
      return undefined
  }
}
