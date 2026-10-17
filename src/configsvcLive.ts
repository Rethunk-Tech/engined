/** The half of the config UI's API that looks at the running system: engined's own endpoints, model files, the keyring. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { loadConfig } from './config.ts'
import { type ConfigsvcDeps, readJson } from './configsvcApi.ts'
import { shippedEngines } from './configsvcShipped.ts'
import { readGgufMetadata } from './ggufMetadata.ts'
import { jsonError, STATUS_BAD_REQUEST, STATUS_NOT_FOUND } from './http.ts'
import { runProbes } from './probe.ts'
import { errMessage, isRecord } from './records.ts'
import type { Config } from './types.ts'

const STATUS_BAD_GATEWAY = 502
const STATUS_UNPROCESSABLE = 422
const MODEL_EXTENSIONS = new Set([
  '.gguf',
  '.bin',
  '.safetensors',
  '.ckpt',
  '.pt',
  '.pth',
  '.onnx',
  '.sft',
])
const MAX_MODEL_FILES = 5000
const MAX_DEPTH = 6
const TEST_ROUTE_TIMEOUT_MS = 120_000

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

interface ModelFile {
  path: string
  bytes: number
  gguf?: {
    architecture?: string
    context_length?: number
    block_count?: number
    head_count?: number
    head_count_kv?: number
    embedding_length?: number
    key_length?: number
    full_attention_interval?: number
    nextn_predict_layers?: number
    value_length?: number
    quantization?: string
    has_chat_template: boolean
  }
}

const ggufCache = new Map<
  string,
  { mtimeMs: number; gguf: NonNullable<ModelFile['gguf']> | null }
>()

async function ggufDetails(file: string, mtimeMs: number): Promise<ModelFile['gguf']> {
  const cached = ggufCache.get(file)
  if (cached?.mtimeMs === mtimeMs) {
    return cached.gguf ?? undefined
  }
  let gguf: NonNullable<ModelFile['gguf']> | null = null
  try {
    const meta = await readGgufMetadata(file)
    gguf = {
      architecture: meta.architecture,
      context_length: meta.contextLength,
      block_count: meta.blockCount,
      head_count: meta.headCount,
      head_count_kv: meta.headCountKv,
      embedding_length: meta.embeddingLength,
      key_length: meta.keyLength,
      value_length: meta.valueLength,
      full_attention_interval: meta.fullAttentionInterval,
      nextn_predict_layers: meta.nextnPredictLayers,
      quantization: meta.quantization,
      has_chat_template: meta.hasChatTemplate,
    }
  } catch {
    // Not a readable GGUF: listed without details.
  }
  ggufCache.set(file, { mtimeMs, gguf })
  return gguf ?? undefined
}

async function modelFiles(root: string): Promise<ModelFile[]> {
  const found: ModelFile[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_MODEL_FILES) {
        return
      }
      const full = join(dir, entry.name)
      let stat: import('node:fs').Stats
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (depth < MAX_DEPTH) {
          await walk(full, depth + 1)
        }
      } else if (
        MODEL_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase())
      ) {
        const file: ModelFile = { path: relative(root, full), bytes: stat.size }
        if (entry.name.endsWith('.gguf')) {
          file.gguf = await ggufDetails(full, stat.mtimeMs)
        }
        found.push(file)
      }
    }
  }
  await walk(root, 0)
  return found
}

async function models(deps: ConfigsvcDeps): Promise<Response> {
  const config = savedConfig(deps)
  if (config instanceof Response) {
    return config
  }
  const engines = []
  for (const engine of config.engines) {
    if (engine.models_dir !== undefined) {
      engines.push({
        engine: engine.id,
        dir: engine.models_dir,
        files: await modelFiles(engine.models_dir),
      })
    }
  }
  return Response.json({ engines, mem: memInfo() })
}

/** MemTotal and MemAvailable in bytes; undefined off Linux. */
function memInfo(): { total: number; available: number } | undefined {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8')
    const kib = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text)?.[1])
    const total = kib('MemTotal') * 1024
    const available = kib('MemAvailable') * 1024
    return Number.isFinite(total) && Number.isFinite(available) ? { total, available } : undefined
  } catch {
    return undefined
  }
}

/** Shipped engines with the files already sitting in each one's default weights directory. */
async function shipped(deps: ConfigsvcDeps): Promise<Response> {
  const engines = await Promise.all(
    shippedEngines(deps.enginesRoot).map(async (engine) => ({
      ...engine,
      files: engine.models_path === undefined ? [] : await modelFiles(engine.models_path),
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
  if (!(body && nonEmpty(body.service) && nonEmpty(body.username) && nonEmpty(body.value))) {
    return jsonError(STATUS_BAD_REQUEST, '"service", "username" and "value" are required strings')
  }
  const stored = await deps.secrets.store(body.service, body.username, body.value)
  return Response.json(stored.ok ? { ok: true } : { ok: false, error: stored.error }, {
    status: stored.ok ? 200 : STATUS_BAD_GATEWAY,
  })
}

async function testRoute(req: Request, deps: ConfigsvcDeps): Promise<Response> {
  const body = await readJson(req)
  if (!(body && nonEmpty(body.address) && body.address.startsWith('@/'))) {
    return jsonError(STATUS_BAD_REQUEST, '"address" must be an "@/..." route address')
  }
  const started = performance.now()
  try {
    const res = await deps.fetch(`${deps.doorUrl()}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: body.address,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(TEST_ROUTE_TIMEOUT_MS),
    })
    const answer: unknown = await res.json().catch(() => undefined)
    const error =
      isRecord(answer) && isRecord(answer.error) ? String(answer.error.message) : undefined
    return Response.json({ status: res.status, ms: Math.round(performance.now() - started), error })
  } catch (err) {
    return Response.json({
      status: 0,
      ms: Math.round(performance.now() - started),
      error: errMessage(err),
    })
  }
}

async function inventory(req: Request, deps: ConfigsvcDeps): Promise<Response> {
  const body = await readJson(req)
  if (!(body && nonEmpty(body.upstream))) {
    return jsonError(STATUS_BAD_REQUEST, '"upstream" is required')
  }
  return proxy(deps, `/engined/v1/upstreams/${encodeURIComponent(body.upstream)}/refresh`, {
    method: 'POST',
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

const ENGINE_VERB_RE = /^\/api\/(logs|resources)\/([^/]+)$/

const PROXIED_GET: Record<string, string> = {
  '/api/status': '/engined/v1/engines',
  '/api/events': '/engined/v1/engines/events',
  '/api/usage': '/engined/v1/usage',
}

export function liveApi(
  req: Request,
  path: string,
  deps: ConfigsvcDeps,
): Response | Promise<Response> | undefined {
  if (req.method === 'GET') {
    const target = PROXIED_GET[path]
    if (target !== undefined) {
      return proxy(deps, `${target}${new URL(req.url).search}`, { signal: req.signal })
    }
    const verb = ENGINE_VERB_RE.exec(path)
    if (verb !== null) {
      const id = encodeURIComponent(decodeURIComponent(verb[2] as string))
      return proxy(deps, `/engined/v1/engines/${id}/${verb[1]}${new URL(req.url).search}`)
    }
    const spec = /^\/api\/spec\/([^/]+)$/.exec(path)?.[1]
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
  const obtain = /^\/api\/obtain\/([^/]+)$/.exec(path)?.[1]
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
