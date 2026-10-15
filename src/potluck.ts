/**
 * The potluck half of a remote upstream: the donor's monthly ceiling, and the
 * liveness report potluck cannot produce itself. potluck holds the age
 * recipient and no identity, so a revoked key or a still-working one is
 * visible only in the calls this door already makes.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import type { DoorContext } from './doorContext.ts'
import {
  CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  STATUS_FORBIDDEN,
  STATUS_PAYMENT_REQUIRED,
  STATUS_UNAUTHORIZED,
} from './http.ts'
import { stateDir } from './paths.ts'
import type { Attempt, CallRecord } from './provenance.ts'
import { errMessage, finiteNumber, isRecord, parseRecord } from './records.ts'
import { resolveSecret } from './secrets.ts'
import type { Upstream } from './types.ts'

/** Phrase the reporter treats as engined's own ceiling, not the provider revoking the key. */
export const MONTHLY_CAP_REACHED = 'monthly cap reached'

const DEAD_STATUSES = new Set([STATUS_UNAUTHORIZED, STATUS_PAYMENT_REQUIRED, STATUS_FORBIDDEN])
const REPORT_TIMEOUT_MS = 5000
const FINGERPRINT = /^[0-9a-f]{64}$/
const HTTP_STATUS_IN_FAILURE = /^http (\d+)/
/** `YYYY-MM` is the first seven characters of an ISO timestamp. */
const MONTH_KEY_LENGTH = 7

interface SpendFile {
  months: Record<string, Record<string, number>>
}

export interface DonorLedgerOptions {
  /** Directory the spend file lives in. Defaults to `stateDir()`. */
  stateRoot?: string
  now?: () => number
}

function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, MONTH_KEY_LENGTH)
}

function learnedStatus(attempt: Attempt): 'live' | 'dead' | undefined {
  if (attempt.ok) {
    return 'live'
  }
  // Our own ceiling refusal uses 402, the same status a provider uses for an
  // empty balance. The wording is what keeps a cap from being reported as
  // the key being dead.
  if (attempt.failure?.includes(MONTHLY_CAP_REACHED)) {
    return
  }
  const status = HTTP_STATUS_IN_FAILURE.exec(attempt.failure ?? '')
  const code = status?.[1]
  if (code === undefined) {
    return
  }
  return DEAD_STATUSES.has(Number(code)) ? 'dead' : undefined
}

/**
 * USD this process has seen fingerprinted upstreams report, per UTC month.
 * A restart reloads the file; a call that reported no cost adds nothing.
 */
export class DonorLedger {
  private readonly months = new Map<string, Map<string, number>>()
  private readonly opts: DonorLedgerOptions

  constructor(opts: DonorLedgerOptions = {}) {
    this.opts = opts
    this.load()
  }

  spent(upstreamId: string, now = this.opts.now?.() ?? Date.now()): number {
    return this.months.get(monthKey(now))?.get(upstreamId) ?? 0
  }

  /** The refusal body when this upstream's reported spend has met its ceiling. */
  refusal(upstream: Upstream, now = this.opts.now?.() ?? Date.now()): string | undefined {
    if (upstream.monthly_cap_usd === undefined) {
      return
    }
    if (this.spent(upstream.id, now) < upstream.monthly_cap_usd) {
      return
    }
    return `upstream "${upstream.id}" ${MONTHLY_CAP_REACHED}`
  }

  note(upstreamId: string, costUsd: number, now = this.opts.now?.() ?? Date.now()): void {
    if (!(Number.isFinite(costUsd) && costUsd > 0)) {
      return
    }
    const key = monthKey(now)
    const month = this.months.get(key) ?? new Map<string, number>()
    month.set(upstreamId, (month.get(upstreamId) ?? 0) + costUsd)
    this.months.set(key, month)
    this.save()
  }

  /**
   * Fold this call's reported costs into the ceiling, then post what the
   * call showed about each fingerprinted upstream. The cost fold happens
   * before the first await so the next request on this door already sees it.
   */
  async observe(ctx: DoorContext, record: CallRecord): Promise<void> {
    const attempts = [...record.attempts, ...(record.vision_bridge ?? [])]
    for (const attempt of attempts) {
      const id = attempt.upstream_used
      const cost = attempt.usage?.cost_usd
      if (id !== undefined && cost !== undefined) {
        this.note(id, cost)
      }
    }
    const callback = ctx.getConfig().potluck
    if (callback === undefined) {
      return
    }
    const reports = new Map<string, 'live' | 'dead'>()
    for (const attempt of attempts) {
      const upstream = ctx.getConfig().upstreams.find((item) => item.id === attempt.upstream_used)
      const fingerprint = upstream?.fingerprint
      if (fingerprint === undefined || !FINGERPRINT.test(fingerprint)) {
        continue
      }
      const learned = learnedStatus(attempt)
      if (learned === undefined || reports.get(fingerprint) === 'dead') {
        continue
      }
      reports.set(fingerprint, learned)
    }
    if (reports.size === 0) {
      return
    }
    const token = await resolveSecret(callback.secret, ctx.doorOpts.secretExec)
    if (!token.ok) {
      throw new Error(`callback secret unavailable: ${token.fix}`)
    }
    const lastUsedAt = new Date().toISOString()
    await Promise.all(
      [...reports].map(async ([fingerprint, status]) => {
        const response = await fetch(callback.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token.value}`,
            [CONTENT_TYPE]: JSON_CONTENT_TYPE,
          },
          body: JSON.stringify({ fingerprint, status, lastUsedAt }),
          redirect: 'error',
          signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
        })
        if (!response.ok) {
          throw new Error(`callback responded ${response.status}`)
        }
      }),
    )
  }

  private path(): string {
    return join(this.opts.stateRoot ?? stateDir(), 'donor-spend.json')
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.path(), 'utf8')
    } catch {
      return
    }
    const raw = parseRecord(text)
    if (raw === null || !isRecord(raw.months)) {
      return
    }
    for (const [month, rows] of Object.entries(raw.months)) {
      if (!isRecord(rows)) {
        continue
      }
      const saved = new Map<string, number>()
      for (const [id, value] of Object.entries(rows)) {
        const amount = finiteNumber(value)
        if (amount !== undefined && amount > 0) {
          saved.set(id, amount)
        }
      }
      if (saved.size > 0) {
        this.months.set(month, saved)
      }
    }
  }

  private save(): void {
    const months: SpendFile['months'] = {}
    for (const [month, rows] of this.months) {
      months[month] = Object.fromEntries(rows)
    }
    const file = this.path()
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify({ months })}\n`)
    } catch (err) {
      process.stderr.write(`potluck: could not write spend file: ${errMessage(err)}\n`)
    }
  }
}
