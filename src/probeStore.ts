import { routeAddress } from './control.ts'
import type { DoorContext } from './doorContext.ts'
import { jsonError, STATUS_BAD_REQUEST } from './http.ts'

export const PROBES_PATH = '/engined/v1/probes'

export type ProbeKind = 'translation' | 'rerank'

const KINDS: readonly ProbeKind[] = ['translation', 'rerank']

/**
 * One address's latest quality-probe answer.
 *
 * `quality` is the probe's verdict and nothing more: it is shaped to be passed
 * whole as `refuseTranslate`'s `probe`. A `translation` outcome says an
 * English-only transcription route refused `/translations` as it must; the
 * probe never grades a `translate = true` route's English, so such a row has
 * no outcome at all.
 */
export interface ProbeResult {
  kind: ProbeKind
  quality: boolean
  detail: string
  /** ISO-8601 instant the door recorded the verdict. */
  at: string
}

/** A result with the address and engine it belongs to, as the engines list serves it. */
export interface EngineProbe extends ProbeResult {
  address: string
}

/** In memory by design: a verdict describes the running containers, so a restarted door starts with none rather than a stale pass. */
export class ProbeStore {
  private readonly byAddress = new Map<string, { engine: string; result: ProbeResult }>()

  record(engine: string, address: string, result: ProbeResult): void {
    this.byAddress.set(address, { engine, result })
  }

  forAddress(address: string): ProbeResult | undefined {
    return this.byAddress.get(address)?.result
  }

  forEngine(engine: string): EngineProbe[] {
    return [...this.byAddress]
      .filter(([, v]) => v.engine === engine)
      .map(([address, v]) => ({ address, ...v.result }))
  }
}

interface Submitted {
  address: string
  kind: ProbeKind
  quality: boolean
  detail: string
}

function parseSubmitted(body: unknown): Submitted[] | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined
  }
  const results = (body as { results?: unknown }).results
  if (!Array.isArray(results)) {
    return undefined
  }
  const parsed: Submitted[] = []
  for (const item of results as unknown[]) {
    if (typeof item !== 'object' || item === null) {
      return undefined
    }
    const { address, kind, quality, detail } = item as Record<string, unknown>
    if (
      typeof address !== 'string' ||
      typeof quality !== 'boolean' ||
      typeof detail !== 'string' ||
      !KINDS.includes(kind as ProbeKind)
    ) {
      return undefined
    }
    parsed.push({ address, kind: kind as ProbeKind, quality, detail })
  }
  return parsed
}

/**
 * `POST /engined/v1/probes`: `engined --probe` runs in another process, so
 * this is how its verdicts reach the door that serves the listings. An
 * address no route answers for is a 400 and records nothing from the batch.
 */
export async function handleProbes(ctx: DoorContext, req: Request): Promise<Response> {
  const submitted = parseSubmitted(await req.json().catch(() => undefined))
  if (submitted === undefined) {
    return jsonError(
      STATUS_BAD_REQUEST,
      'body must be {"results":[{"address","kind":"translation"|"rerank","quality","detail"}]}',
    )
  }
  const { routes } = ctx.getConfig()
  const resolved: [string, Submitted][] = []
  for (const s of submitted) {
    const route = routes.find((r) => !r.disabled && routeAddress(r, routes) === s.address)
    if (route === undefined) {
      return jsonError(STATUS_BAD_REQUEST, `no route answers for "${s.address}"`)
    }
    resolved.push([route.engine, s])
  }
  const at = new Date().toISOString()
  for (const [engine, s] of resolved) {
    ctx.probes.record(engine, s.address, { kind: s.kind, quality: s.quality, detail: s.detail, at })
  }
  return Response.json({ recorded: resolved.length })
}
