/** Asking a provider what it serves: Anthropic's Models API for claude, `cursor-agent --list-models` for cursor. */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveCursorBinary } from './agents.ts'
import { envString } from './env.ts'
import { binExec, type Exec } from './exec.ts'
import type { HttpClient } from './http.ts'
import { finiteNumber, isRecord, parseRecord } from './records.ts'
import type { ModelCapabilities } from './types.ts'

export const CLAUDE_ENGINE_ID = 'claude'
const CURSOR_ENGINE_ID = 'cursor'
const MODELS_URL = 'https://api.anthropic.com/v1/models'
const MAX_PAGES = 10
const MODELS_PAGE_SIZE = 1000
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000
const CLAUDE_PREFIX = /^claude-/
const CURSOR_ROW = /^(\S+) - (.+)$/
const DATE_SUFFIX = /-\d{8}$/
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

export interface DiscoveredModel {
  /** The id the provider serves; sent on the wire. */
  wire: string
  /** The route `model` segment it is addressed by. */
  segment: string
  display_name?: string
  /** The provider's model line (`sonnet`), when it names one. */
  line?: string
  created?: string
  /** The provider itself marks this its default. */
  provider_default?: boolean
  capabilities: ModelCapabilities
}

export type ModelSource = () => Promise<DiscoveredModel[]>

export interface DiscoveryOptions {
  fetch?: HttpClient
  /** Runs `cursor-agent --list-models`; defaults to the resolved cursor binary. */
  cursorExec?: Exec
  env?: Record<string, string | undefined>
  /** Directory holding `.credentials.json`; defaults to `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeDir?: string
  now?: () => number
  stateRoot?: string
  log?: (line: string) => void
  /** Ceiling on one provider ask, so a provider that never answers cannot pile up refreshes. */
  fetchTimeoutMs?: number
}

/** `claude-haiku-4-5-20251001` is addressed as `haiku-4-5`, matching the hand-written convention. */
function claudeSegment(wire: string): string {
  return wire.replace(CLAUDE_PREFIX, '').replace(DATE_SUFFIX, '')
}

function claudeCapabilities(row: Record<string, unknown>): ModelCapabilities {
  const caps = isRecord(row.capabilities) ? row.capabilities : {}
  const supported = (v: unknown): boolean => isRecord(v) && v.supported === true
  const effort = isRecord(caps.effort) ? caps.effort : {}
  const reasoning = EFFORT_LEVELS.filter((level) => supported(effort[level]))
  return {
    input: supported(caps.image_input) ? ['text', 'image'] : ['text'],
    output: ['text'],
    context_in: finiteNumber(row.max_input_tokens),
    context_out: finiteNumber(row.max_tokens),
    reasoning: reasoning.length > 0 ? reasoning : undefined,
  }
}

/** One page of Anthropic's Models API (`GET /v1/models`) as models, plus the cursor to the next. */
function parseClaudePage(body: unknown): { models: DiscoveredModel[]; next?: string } {
  if (!(isRecord(body) && Array.isArray(body.data))) {
    throw new Error('GET /v1/models was not a models list')
  }
  const models: DiscoveredModel[] = []
  for (const row of body.data) {
    if (!(isRecord(row) && typeof row.id === 'string')) {
      continue
    }
    models.push({
      wire: row.id,
      segment: claudeSegment(row.id),
      display_name: typeof row.display_name === 'string' ? row.display_name : undefined,
      line: typeof row.line === 'string' ? row.line : undefined,
      created: typeof row.created_at === 'string' ? row.created_at : undefined,
      capabilities: claudeCapabilities(row),
    })
  }
  const last = models.at(-1)
  return { models, next: body.has_more === true ? last?.wire : undefined }
}

/**
 * The credential the Models API accepts: `ANTHROPIC_API_KEY`, else the access
 * token the Claude CLI keeps for its own login. The CLI refreshes that token
 * whenever it runs, so an expired one is a failed refresh (the cache serves),
 * not something engined renews.
 */
function claudeAuthHeaders(opts: DiscoveryOptions, now: number): Record<string, string> {
  const apiKey = opts.env?.ANTHROPIC_API_KEY ?? envString('ANTHROPIC_API_KEY')
  const base = { 'anthropic-version': '2023-06-01' }
  if (apiKey !== undefined && apiKey !== '') {
    return { ...base, 'x-api-key': apiKey }
  }
  const dir =
    opts.claudeDir ??
    opts.env?.CLAUDE_CONFIG_DIR ??
    envString('CLAUDE_CONFIG_DIR') ??
    join(homedir(), '.claude')
  const path = join(dir, '.credentials.json')
  const creds = existsSync(path) ? parseRecord(readFileSync(path, 'utf8')) : null
  const oauth = creds !== null && isRecord(creds.claudeAiOauth) ? creds.claudeAiOauth : undefined
  if (oauth === undefined || typeof oauth.accessToken !== 'string') {
    throw new Error(`no ANTHROPIC_API_KEY and no Claude login in ${path}`)
  }
  const expiresAt = finiteNumber(oauth.expiresAt)
  if (expiresAt !== undefined && expiresAt <= now) {
    throw new Error(`the Claude login token in ${path} has expired; running claude refreshes it`)
  }
  return {
    ...base,
    authorization: `Bearer ${oauth.accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
  }
}

function claudeSource(opts: DiscoveryOptions): ModelSource {
  return async () => {
    const http = opts.fetch ?? fetch
    const headers = claudeAuthHeaders(opts, opts.now?.() ?? Date.now())
    const models: DiscoveredModel[] = []
    let after: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(MODELS_URL)
      url.searchParams.set('limit', String(MODELS_PAGE_SIZE))
      if (after !== undefined) {
        url.searchParams.set('after_id', after)
      }
      const res = await http(url.toString(), {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
      })
      if (!res.ok) {
        throw new Error(`GET /v1/models returned HTTP ${res.status}`)
      }
      const parsed = parseClaudePage(await res.json())
      models.push(...parsed.models)
      after = parsed.next
      if (after === undefined) {
        return models
      }
    }
    throw new Error(`GET /v1/models paged past ${MAX_PAGES} pages`)
  }
}

/** `cursor-agent --list-models` prints `<id> - <Display Name>` rows between a header and a tip. */
export function parseCursorModels(stdout: string): DiscoveredModel[] {
  const models: DiscoveredModel[] = []
  for (const line of stdout.split('\n')) {
    const match = CURSOR_ROW.exec(line.trim())
    if (match === null) {
      continue
    }
    const [, id, display] = match as unknown as [string, string, string]
    models.push({
      wire: id,
      segment: id,
      display_name: display,
      provider_default: display.includes('(default)'),
      capabilities: {},
    })
  }
  return models
}

function cursorSource(opts: DiscoveryOptions): ModelSource {
  return async () => {
    const exec =
      opts.cursorExec ??
      binExec(resolveCursorBinary(), opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS)
    const result = await exec(['--list-models'])
    if (result.exitCode !== 0) {
      throw new Error(`cursor --list-models exited ${result.exitCode}: ${result.stderr.trim()}`)
    }
    const models = parseCursorModels(result.stdout)
    if (models.length === 0) {
      throw new Error('cursor --list-models listed no models')
    }
    return models
  }
}

export const SOURCES: Record<string, (opts: DiscoveryOptions) => ModelSource> = {
  [CLAUDE_ENGINE_ID]: claudeSource,
  [CURSOR_ENGINE_ID]: cursorSource,
}
