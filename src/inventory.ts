/**
 * Provider `/models` catalogs for wildcard remote routes. Fetched with the
 * same secret resolution as a hop, persisted without the secret, and dropped
 * once older than the upstream's max age.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Exec as SecretExec } from './exec.ts'
import type { HttpClient } from './http.ts'
import { upstreamInventoryDir } from './paths.ts'
import { errMessage, isRecord, MS_PER_SECOND, parseRecord } from './records.ts'
import { WILDCARD_MODEL } from './routeAddress.ts'
import type { Upstream } from './types.ts'
import { resolveUpstream, upstreamUrl } from './upstream.ts'

const MODELS_PATH = '/models'
const CACHE_FILE = 'inventory.json'
const ENCODED_SLASH = '%2F'

export interface InventoryOptions {
  fetch?: HttpClient
  secretExec?: SecretExec
  now?: () => number
  /** Defaults to `stateDir()`. Tests redirect this so nothing writes under the operator's state. */
  stateRoot?: string
}

export interface InventoryLookup {
  ids: string[]
  /** Set when ids came from an in-age cache because the live fetch failed. */
  fetchError?: string
  /** Set when the upstream was forgotten while this fetch was in flight; nothing was cached. */
  stale?: boolean
}

interface CachedInventory {
  fetchedAt: number
  ids: string[]
}

/**
 * Address segment for a provider id: only `/` becomes `%2F`. An id that
 * already contains that sequence, or that is the wildcard sentinel, cannot
 * round-trip as a segment and is skipped.
 */
export function encodeAddressSegment(providerId: string): string | undefined {
  if (providerId === WILDCARD_MODEL || providerId.includes(ENCODED_SLASH)) {
    return
  }
  return providerId.replaceAll('/', ENCODED_SLASH)
}

/** Reverse of `encodeAddressSegment`: only `%2F` becomes `/`. */
export function decodeAddressSegment(segment: string): string {
  return segment.replaceAll(ENCODED_SLASH, '/')
}

function isFresh(fetchedAt: number, maxAgeSeconds: number, now: number): boolean {
  return now - fetchedAt <= maxAgeSeconds * MS_PER_SECOND
}

function parseCache(raw: unknown): CachedInventory | undefined {
  if (!isRecord(raw) || typeof raw.fetched_at !== 'number' || !Array.isArray(raw.ids)) {
    return
  }
  if (!raw.ids.every((id): id is string => typeof id === 'string')) {
    return
  }
  return {
    fetchedAt: raw.fetched_at,
    ids: raw.ids.filter((id) => encodeAddressSegment(id) !== undefined),
  }
}

function parseModelsBody(raw: unknown): string[] | undefined {
  if (!(isRecord(raw) && Array.isArray(raw.data))) {
    return
  }
  const ids: string[] = []
  for (const row of raw.data) {
    if (!isRecord(row) || typeof row.id !== 'string') {
      continue
    }
    if (encodeAddressSegment(row.id) === undefined) {
      continue
    }
    ids.push(row.id)
  }
  return ids
}

/** Live catalog cache, one in-memory entry per upstream, mirrored under `upstreams/<id>/`. */
export class Inventory {
  private readonly mem = new Map<string, CachedInventory>()
  /** Bumped by `forget`, so a fetch that began before it cannot write the old provider's list back. */
  private readonly generations = new Map<string, number>()
  private readonly opts: InventoryOptions

  constructor(opts: InventoryOptions = {}) {
    this.opts = opts
  }

  /** Drops these upstreams' catalogs from memory and disk, so a re-pointed upstream never serves its old provider's list. */
  forget(upstreamIds: Iterable<string>): void {
    for (const id of upstreamIds) {
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
      this.mem.delete(id)
      this.dropFile(id)
    }
  }

  /**
   * In-age ids with no network. Empty when nothing has been fetched yet, or
   * the file is past max age (and then the file is removed).
   */
  peek(upstream: Upstream): string[] {
    return this.loadFresh(upstream)?.ids ?? []
  }

  async refresh(upstream: Upstream): Promise<InventoryLookup> {
    const generation = this.generations.get(upstream.id)
    const live = await this.fetchIds(upstream)
    if (this.generations.get(upstream.id) !== generation) {
      return { ids: [], stale: true }
    }
    if (live.ok) {
      const cached: CachedInventory = { fetchedAt: this.now(), ids: live.ids }
      this.mem.set(upstream.id, cached)
      this.writeFile(upstream.id, cached)
      return { ids: live.ids }
    }
    const cached = this.loadFresh(upstream)
    if (cached !== undefined) {
      return { ids: cached.ids, fetchError: live.error }
    }
    return { ids: [], fetchError: live.error }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private cachePath(upstreamId: string): string {
    if (this.opts.stateRoot !== undefined) {
      return join(this.opts.stateRoot, 'upstreams', upstreamId, CACHE_FILE)
    }
    return join(upstreamInventoryDir(upstreamId), CACHE_FILE)
  }

  private loadFresh(upstream: Upstream): CachedInventory | undefined {
    const maxAge = upstream.inventory_max_age_seconds
    if (maxAge === undefined) {
      return
    }
    const fromMem = this.mem.get(upstream.id)
    if (fromMem !== undefined) {
      if (isFresh(fromMem.fetchedAt, maxAge, this.now())) {
        return fromMem
      }
      this.mem.delete(upstream.id)
      this.dropFile(upstream.id)
      return
    }
    const fromDisk = this.readFile(upstream.id)
    if (fromDisk === undefined) {
      return
    }
    if (!isFresh(fromDisk.fetchedAt, maxAge, this.now())) {
      this.dropFile(upstream.id)
      return
    }
    this.mem.set(upstream.id, fromDisk)
    return fromDisk
  }

  private readFile(upstreamId: string): CachedInventory | undefined {
    let text: string
    try {
      text = readFileSync(this.cachePath(upstreamId), 'utf8')
    } catch {
      return
    }
    const raw = parseRecord(text)
    if (raw === null) {
      this.dropFile(upstreamId)
      return
    }
    const parsed = parseCache(raw)
    if (parsed === undefined) {
      this.dropFile(upstreamId)
    }
    return parsed
  }

  private writeFile(upstreamId: string, cached: CachedInventory): void {
    const path = this.cachePath(upstreamId)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ fetched_at: cached.fetchedAt, ids: cached.ids })}\n`)
    renameSync(tmp, path)
  }

  private dropFile(upstreamId: string): void {
    try {
      unlinkSync(this.cachePath(upstreamId))
    } catch {
      // Absent is the desired state.
    }
  }

  private async fetchIds(
    upstream: Upstream,
  ): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
    const resolution = await resolveUpstream(upstream, this.opts.secretExec)
    if (!resolution.ok) {
      return { ok: false, error: resolution.error }
    }
    const http = this.opts.fetch ?? fetch
    let res: Response
    try {
      res = await http(upstreamUrl(resolution.endpoint.base_url, MODELS_PATH), {
        method: 'GET',
        headers: resolution.endpoint.headers,
        redirect: 'error',
      })
    } catch (err) {
      return { ok: false, error: errMessage(err) }
    }
    if (!res.ok) {
      return { ok: false, error: `GET ${MODELS_PATH} returned HTTP ${res.status}` }
    }
    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      return { ok: false, error: errMessage(err) }
    }
    const ids = parseModelsBody(body)
    if (ids === undefined) {
      return { ok: false, error: `GET ${MODELS_PATH} was not an OpenAI models list` }
    }
    return { ok: true, ids }
  }
}
