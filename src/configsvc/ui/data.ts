/** Server data the views share: specs, schema help, model files, usage, secrets and live engine state. */
import { signal } from '@preact/signals'
import { call } from './api.ts'
import { parseSpec, type SpecInfo } from './model.ts'

export interface SpecEntry {
  info: SpecInfo
  text: string
  file: string
}

export interface LiveEngine {
  id: string
  kind: string
  state: string
  disabled?: boolean
  fix?: string
  last_error?: string
  superseded?: string
  serves: string[]
}

export interface ModelFile {
  path: string
  bytes: number
  gguf?: {
    architecture?: string
    context_length?: number
    quantization?: string
    has_chat_template: boolean
  }
}

interface UsageRow {
  date: string
  route: string
  requests: number
  failed: number
  cost_usd?: number
}

export const specs = signal<Record<string, SpecEntry | null>>({})
export const modelFiles = signal<{ engine: string; dir: string; files: ModelFile[] }[]>([])
const usage = signal<UsageRow[]>([])
export const liveEngines = signal<Record<string, LiveEngine>>({})
export const discovery = signal<{
  providers: Record<string, unknown>
  inventories: Record<string, unknown>
}>({
  providers: {},
  inventories: {},
})

const asking = new Set<string>()

/** Loads an engine's spec.toml once; an engine with none (a spec-less `kind` engine) is remembered as null. */
export async function ensureSpec(id: string): Promise<void> {
  if (id in specs.value || asking.has(id)) {
    return
  }
  asking.add(id)
  try {
    const got = await call<{ file: string; text: string }>(`/api/spec/${encodeURIComponent(id)}`)
    specs.value = {
      ...specs.value,
      [id]: { info: parseSpec(got.text), text: got.text, file: got.file },
    }
  } catch {
    specs.value = { ...specs.value, [id]: null }
  } finally {
    asking.delete(id)
  }
}

/** A spec is re-read when its engine's config changes (a new `spec_dir` or `kind`). */
export function forgetSpec(id: string): void {
  const { [id]: _gone, ...rest } = specs.value
  specs.value = rest
}

export async function loadModelFiles(): Promise<void> {
  try {
    modelFiles.value = (await call<{ engines: typeof modelFiles.value }>('/api/models')).engines
  } catch {
    modelFiles.value = []
  }
}

export async function loadUsage(): Promise<void> {
  try {
    usage.value = (await call<{ data: UsageRow[] }>('/api/usage?days=7')).data
  } catch {
    usage.value = []
  }
}

export async function loadDiscovery(): Promise<void> {
  try {
    discovery.value = await call('/api/discovery')
  } catch {
    // The caches are advisory suggestions; their absence leaves the lists shorter.
  }
}

/** Seven-day call count of one address. */
export function callsFor(address: string | undefined): number {
  return address === undefined
    ? 0
    : usage.value.filter((row) => row.route === address).reduce((sum, row) => sum + row.requests, 0)
}

/** Live engine state over SSE; returns the stop function. */
export function watchEngines(): () => void {
  const source = new EventSource('/api/events')
  const merge = (list: LiveEngine[]) => {
    liveEngines.value = { ...liveEngines.value, ...Object.fromEntries(list.map((e) => [e.id, e])) }
  }
  source.addEventListener('snapshot', (e) => {
    const body = JSON.parse((e as MessageEvent<string>).data) as { engines?: LiveEngine[] }
    merge(body.engines ?? [])
  })
  source.addEventListener('engine', (e) =>
    merge([JSON.parse((e as MessageEvent<string>).data) as LiveEngine]),
  )
  return () => source.close()
}
