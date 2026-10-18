/** Server data the views share: specs, schema help, model files, usage, secrets and live engine state. */
import { signal } from '@preact/signals'
import type { ModelFile } from '../../configsvcModelFile.ts'
import { call } from './api.ts'
import {
  type Doc,
  defaultUpstream,
  engineTrait,
  parseSpec,
  routesOf,
  type SpecInfo,
  type Table,
} from './model.ts'

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

export type { ModelFile }

export interface UsageRow {
  date: string
  route: string
  requests: number
  failed: number
  cost_usd?: number
}

export const specs = signal<Record<string, SpecEntry | null>>({})
export const modelFiles = signal<{ engine: string; dir: string; files: ModelFile[] }[]>([])
export const boxMemory = signal<{ total: number; available: number } | undefined>(undefined)
export const usage = signal<UsageRow[]>([])
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
    const res = await call<{
      engines: typeof modelFiles.value
      mem?: { total: number; available: number }
    }>('/api/models')
    modelFiles.value = res.engines
    boxMemory.value = res.mem
  } catch {
    modelFiles.value = []
  }
}

export async function loadUsage(): Promise<void> {
  try {
    usage.value = (await call<{ data: UsageRow[] }>('/api/usage?days=31')).data
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

const DAY_MS = 24 * 60 * 60 * 1000

/** Seven-day call count of one address. */
export function callsFor(address: string | undefined): number {
  const since = new Date(Date.now() - 6 * DAY_MS).toISOString().slice(0, 10)
  return address === undefined
    ? 0
    : usage.value
        .filter((row) => row.route === address && row.date >= since)
        .reduce((sum, row) => sum + row.requests, 0)
}

/** What the given addresses cost in the current UTC month, from the costs their upstreams reported. */
export function monthSpend(addresses: readonly string[]): number {
  const month = new Date().toISOString().slice(0, 7)
  return usage.value
    .filter((row) => addresses.includes(row.route) && row.date.startsWith(month))
    .reduce((sum, row) => sum + (row.cost_usd ?? 0), 0)
}

/** The upstream a route resolves to: the one it names, else its engine's trait default. */
export function upstreamResolver(doc: Doc): (route: Table) => string | null {
  return (route) => {
    if (typeof route.upstream === 'string') {
      return route.upstream
    }
    const engine = doc.engine.find((e) => e.id === route.engine)
    const siblings =
      engine === undefined ? [] : routesOf(doc, String(engine.id)).map((r) => r.route)
    const trait =
      engine === undefined ? undefined : engineTrait(engine, specs.value[String(engine.id)]?.info)
    return defaultUpstream(trait, siblings).value
  }
}

export interface SecretRow {
  upstream: string
  service: string
  username: string
  present: boolean
}

export const secrets = signal<SecretRow[]>([])

export async function loadSecrets(): Promise<void> {
  try {
    secrets.value = (await call<{ secrets: SecretRow[] }>('/api/secrets')).secrets
  } catch {
    secrets.value = []
  }
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
