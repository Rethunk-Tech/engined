/**
 * `GET /engined/v1/usage`: per-day, per-route totals aggregated from the same
 * per-call records `src/provenance.ts` emits -- counters, not raw records, so
 * this carries no request content and no request id, ever (INVARIANT: no
 * door logs prompt content).
 *
 * Persisted as one JSON file per day under `stateDir()/usage/`, updated in
 * memory on every call and flushed to disk on an interval, never per write --
 * the file is a durability backstop for a restart, not the read path, which
 * always answers from memory.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import type { DoorContext } from './doorContext.ts'
import { jsonError, STATUS_BAD_REQUEST } from './http.ts'
import { stateDir } from './paths.ts'
import type { CallRecord } from './provenance.ts'
import { type Egress, isEgress, isRecord, MS_PER_SECOND, parseRecord } from './types.ts'

export const USAGE_PATH = '/engined/v1/usage'
export const ENGINED_ENGINES_PATH = '/engined/v1/engines'

const DEFAULT_DAYS = 7
const MAX_DAYS = 90
const DEFAULT_FLUSH_INTERVAL_MS = 10_000
const MS_PER_DAY = 24 * 60 * 60 * MS_PER_SECOND

interface RouteCounters {
  requests: number
  ok: number
  failed: number
  prompt_tokens?: number
  completion_tokens?: number
  cost_usd?: number
  duration_ms: number
  egress?: Egress
}

interface DayFile {
  routes: Record<string, RouteCounters>
}

export interface UsageRow extends RouteCounters {
  date: string
  route: string
}

export interface UsageResponse {
  object: 'list'
  data: UsageRow[]
}

export interface UsageOptions {
  now?: () => number
  /** Overrides `stateDir()/usage`; a test redirects this so nothing writes under the operator's state. */
  stateRoot?: string
  flushIntervalMs?: number
  /** Defaults to `process.stderr`; a test captures the one-line corrupt-file notice instead. */
  log?: (line: string) => void
}

function dateKeyFor(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function shiftDateKey(date: string, deltaDays: number): string {
  return dateKeyFor(Date.parse(`${date}T00:00:00Z`) + deltaDays * MS_PER_DAY)
}

/** `a + b`, treating an absent running total OR an absent addend as "nothing known yet" rather than zero -- a route with no reported cost anywhere must read as absent, never `$0`. */
function addKnown(total: number | undefined, addend: number | undefined): number | undefined {
  return addend === undefined ? total : (total ?? 0) + addend
}

function emptyCounters(): RouteCounters {
  return { requests: 0, ok: 0, failed: 0, duration_ms: 0 }
}

function routeKeyFor(attempt: { engine: string; model: string }): string {
  return attempt.model === '' ? attempt.engine : `${attempt.engine}/${attempt.model}`
}

function isCounters(value: unknown): value is RouteCounters {
  if (!isRecord(value)) {
    return false
  }
  const { requests, ok, failed, duration_ms, prompt_tokens, completion_tokens, cost_usd, egress } =
    value
  if (
    typeof requests !== 'number' ||
    typeof ok !== 'number' ||
    typeof failed !== 'number' ||
    typeof duration_ms !== 'number'
  ) {
    return false
  }
  for (const field of [prompt_tokens, completion_tokens, cost_usd]) {
    if (field !== undefined && typeof field !== 'number') {
      return false
    }
  }
  return egress === undefined || isEgress(egress)
}

/** `undefined` for anything that is not a well-shaped day file -- the caller starts that day fresh rather than trusting a partially-read shape. */
function parseDayFile(text: string): DayFile | undefined {
  const raw = parseRecord(text)
  if (raw === null || !isRecord(raw.routes)) {
    return undefined
  }
  const routes: Record<string, RouteCounters> = {}
  for (const [key, value] of Object.entries(raw.routes)) {
    if (!isCounters(value)) {
      return undefined
    }
    routes[key] = value
  }
  return { routes }
}

/** In-memory counters, one `DayFile` per date this process has touched, mirrored to disk on a timer and on `shutdown()`. Reads always answer from memory: a date not yet touched this run is loaded from disk (or started fresh) the first time either `record` or `read` asks for it. */
export class UsageTracker {
  private readonly days = new Map<string, DayFile>()
  private readonly dirty = new Set<string>()
  private readonly opts: UsageOptions
  private readonly timer: ReturnType<typeof setInterval>

  constructor(opts: UsageOptions = {}) {
    this.opts = opts
    this.timer = setInterval(() => this.flush(), opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS)
    // A flush timer must never be the reason a process (or a test) hangs
    // after everything else it was doing has finished.
    this.timer.unref?.()
  }

  /** Every attempt in one call, folded into today's counters -- keyed on `engine`/`engine/model`, the same address shape `chain.ts` already parses hops into. No request content and no request id ever reach a counter. */
  record(call: CallRecord): void {
    const date = this.today()
    const file = this.getOrLoad(date)
    // A vision bridge's caption calls load and run the vision model too, so they count as that route's usage.
    for (const attempt of [...call.attempts, ...(call.vision_bridge ?? [])]) {
      const key = routeKeyFor(attempt)
      const counters = file.routes[key] ?? emptyCounters()
      counters.requests += 1
      if (attempt.ok) {
        counters.ok += 1
      } else {
        counters.failed += 1
      }
      counters.duration_ms += attempt.duration_ms
      counters.prompt_tokens = addKnown(counters.prompt_tokens, attempt.usage?.prompt_tokens)
      counters.completion_tokens = addKnown(
        counters.completion_tokens,
        attempt.usage?.completion_tokens,
      )
      counters.cost_usd = addKnown(counters.cost_usd, attempt.usage?.cost_usd)
      counters.egress = attempt.egress ?? counters.egress
      file.routes[key] = counters
    }
    this.dirty.add(date)
  }

  /** `days` calendar days ending today, most recent first, every route on each. */
  read(days: number): UsageRow[] {
    const rows: UsageRow[] = []
    const today = this.today()
    for (let i = 0; i < days; i += 1) {
      const date = shiftDateKey(today, -i)
      const file = this.getOrLoad(date)
      const routes = Object.entries(file.routes).sort(([a], [b]) => a.localeCompare(b))
      for (const [route, counters] of routes) {
        rows.push({ date, route, ...counters })
      }
    }
    return rows
  }

  /** Every date touched since the last flush, written atomically (temp file + rename). Safe to call any time, including with nothing dirty. */
  flush(): void {
    for (const date of this.dirty) {
      this.writeFile(date)
    }
    this.dirty.clear()
  }

  shutdown(): void {
    clearInterval(this.timer)
    this.flush()
  }

  private today(): string {
    return dateKeyFor(this.opts.now?.() ?? Date.now())
  }

  private dir(): string {
    return this.opts.stateRoot ?? join(stateDir(), 'usage')
  }

  private filePath(date: string): string {
    return join(this.dir(), `${date}.json`)
  }

  private getOrLoad(date: string): DayFile {
    const cached = this.days.get(date)
    if (cached !== undefined) {
      return cached
    }
    const loaded = this.readFile(date)
    this.days.set(date, loaded)
    return loaded
  }

  private readFile(date: string): DayFile {
    const path = this.filePath(date)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return { routes: {} }
    }
    const parsed = parseDayFile(text)
    if (parsed === undefined) {
      const log = this.opts.log ?? ((line: string) => process.stderr.write(`${line}\n`))
      log(`usage: ${path} is corrupt; starting ${date} fresh`)
      return { routes: {} }
    }
    return parsed
  }

  private writeFile(date: string): void {
    const file = this.days.get(date)
    if (file === undefined) {
      return
    }
    mkdirSync(this.dir(), { recursive: true })
    const path = this.filePath(date)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(file)}\n`)
    renameSync(tmp, path)
  }
}

export function handleUsage(ctx: DoorContext, url: URL): Response {
  const raw = url.searchParams.get('days')
  if (raw === null) {
    return Response.json({
      object: 'list',
      data: ctx.usage.read(DEFAULT_DAYS),
    } satisfies UsageResponse)
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    return jsonError(STATUS_BAD_REQUEST, '"days" must be a positive integer')
  }
  const days = Math.min(parsed, MAX_DAYS)
  return Response.json({ object: 'list', data: ctx.usage.read(days) } satisfies UsageResponse)
}
