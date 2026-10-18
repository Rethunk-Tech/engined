/** One weights file the config UI lists under an engine's `models_dir`. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { readGgufMetadata } from './ggufMetadata.ts'

export interface ModelFile {
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
const MEMTOTAL_RE = /^MemTotal:\s+(\d+) kB/m
const MEMAVAIL_RE = /^MemAvailable:\s+(\d+) kB/m

const ggufCache = new Map<
  string,
  { mtimeMs: number; gguf: NonNullable<ModelFile['gguf']> | null }
>()

function cacheSet<V>(map: Map<string, V>, key: string, value: V, cap: number): void {
  map.delete(key)
  map.set(key, value)
  const oldest = map.keys().next().value
  if (map.size > cap && oldest !== undefined) {
    map.delete(oldest)
  }
}

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
  cacheSet(ggufCache, file, { mtimeMs, gguf }, MAX_MODEL_FILES)
  return gguf ?? undefined
}

/** Weights files under `root`, with GGUF metadata when the file is readable. */
export async function listModelFiles(root: string): Promise<ModelFile[]> {
  const found: ModelFile[] = []
  const seen = new Set<string>()
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
          seen.add(full)
          file.gguf = await ggufDetails(full, stat.mtimeMs)
        }
        found.push(file)
      }
    }
  }
  await walk(root, 0)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  for (const key of ggufCache.keys()) {
    if ((key === root || key.startsWith(prefix)) && !seen.has(key)) {
      ggufCache.delete(key)
    }
  }
  return found
}

/** MemTotal and MemAvailable in bytes; undefined off Linux. */
export function memInfo(): { total: number; available: number } | undefined {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8')
    const kib = (re: RegExp) => Number(re.exec(text)?.[1])
    const total = kib(MEMTOTAL_RE) * 1024
    const available = kib(MEMAVAIL_RE) * 1024
    return Number.isFinite(total) && Number.isFinite(available) ? { total, available } : undefined
  } catch {
    return undefined
  }
}
