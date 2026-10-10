/**
 * The upstream fields and the potluck callback table. Split out of `config.ts`
 * so that file stays inside the line ceiling.
 */

import {
  CALLBACK_SECRET_KEYS,
  optional,
  optionalPositive,
  POTLUCK_KEYS,
  requireString,
  requireTable,
} from './configParse.ts'
import { ParseError } from './errors/parse.ts'
import { isRecord } from './records.ts'
import type { PotluckCallback } from './types.ts'

const FINGERPRINT = /^[0-9a-f]{64}$/

export function readFingerprint(value: unknown, site: string, file: string): string | undefined {
  const fingerprint = optional(value, 'string', `${site} "fingerprint"`, file)
  if (fingerprint !== undefined && !FINGERPRINT.test(fingerprint)) {
    throw new ParseError(`${site} "fingerprint" must be 64 hex characters`, file)
  }
  return fingerprint
}

export function readMonthlyCap(value: unknown, site: string, file: string): number | undefined {
  return optionalPositive(value, `${site} "monthly_cap_usd"`, file)
}

export function parsePotluckCallback(
  raw: Record<string, unknown>,
  file: string,
): { potluck: PotluckCallback } | undefined {
  if (raw.potluck === undefined) {
    return
  }
  const table = requireTable(raw.potluck, 'config "potluck"', POTLUCK_KEYS, file)
  const url = requireString(table.callback_url, 'config "potluck.callback_url"', file)
  const secret = requireTable(
    table.callback_secret,
    'config "potluck.callback_secret"',
    CALLBACK_SECRET_KEYS,
    file,
  )
  return {
    potluck: {
      url,
      secret: {
        service: requireString(secret.service, 'config "potluck.callback_secret.service"', file),
        username: requireString(secret.username, 'config "potluck.callback_secret.username"', file),
      },
    },
  }
}

export function parseUpstreamHeaders(
  v: unknown,
  site: string,
  file: string,
  secretHeader: string | undefined,
): Record<string, string> | undefined {
  if (v === undefined) {
    return
  }
  if (!isRecord(v)) {
    throw new ParseError(`${site} "headers" must be a table`, file)
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(v)) {
    if (typeof value !== 'string') {
      throw new ParseError(`${site} "headers" key "${key}" must be a string`, file)
    }
    const lower = key.toLowerCase()
    if (lower === 'host') {
      throw new ParseError(`${site} "headers" must not set "Host"`, file)
    }
    if (secretHeader !== undefined && lower === secretHeader.toLowerCase()) {
      throw new ParseError(
        `${site} "headers" must not set "${key}": that header is set from "secret"`,
        file,
      )
    }
    out[key] = value
  }
  return out
}
