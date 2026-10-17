/**
 * The upstream fields and the potluck callback table. Split out of `config.ts`
 * so that file stays inside the line ceiling.
 */

import {
  CALLBACK_SECRET_KEYS,
  CONFIGSVC_KEYS,
  optional,
  optionalPositive,
  POTLUCK_KEYS,
  parsePort,
  requireString,
  requireTable,
} from './configParse.ts'
import { ParseError } from './errors/parse.ts'
import { isRecord } from './records.ts'
import type { ConfigsvcSettings, PotluckCallback } from './types.ts'

const FINGERPRINT = /^[0-9a-f]{64}$/

export function readFingerprint(value: unknown, site: string, file: string): string | undefined {
  const fingerprint = optional(value, 'string', `${site} "fingerprint"`, file)
  if (fingerprint !== undefined && !FINGERPRINT.test(fingerprint)) {
    throw new ParseError(`${site} "fingerprint" must be 64 hex characters`, {
      file,
      key: 'fingerprint',
    })
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

export const DEFAULT_CONFIGSVC_PORT = 29_202
const ARGON2ID_PREFIX = '$argon2id$'

/** The two listeners are already bound by the door, so `[configsvc]` may not claim either port. */
export function parseConfigsvc(
  raw: Record<string, unknown>,
  ports: { listen: number; cursor: number },
  file: string,
): ConfigsvcSettings {
  const table =
    raw.configsvc === undefined
      ? {}
      : requireTable(raw.configsvc, 'config "configsvc"', CONFIGSVC_KEYS, file)
  const enable = optional(table.enable, 'boolean', 'config "configsvc.enable"', file) ?? false
  const port = parsePort(table.port, 'config "configsvc.port"', file, DEFAULT_CONFIGSVC_PORT)
  const passwordHash = optional(
    table.password_hash,
    'string',
    'config "configsvc.password_hash"',
    file,
  )
  if (passwordHash !== undefined && !passwordHash.startsWith(ARGON2ID_PREFIX)) {
    throw new ParseError(
      `config "configsvc.password_hash" must be an argon2id hash (starts with "${ARGON2ID_PREFIX}")`,
      { file, key: 'configsvc.password_hash' },
    )
  }
  if (enable && (port === ports.listen || port === ports.cursor)) {
    throw new ParseError(
      'config "configsvc.port" must differ from "listen_port" and "cursor_port"',
      { file, key: 'configsvc.port' },
    )
  }
  return {
    enable,
    host: optional(table.host, 'string', 'config "configsvc.host"', file) ?? '127.0.0.1',
    port,
    ...(passwordHash === undefined ? {} : { password_hash: passwordHash }),
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
    throw new ParseError(`${site} "headers" must be a table`, { file, key: 'headers' })
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(v)) {
    if (typeof value !== 'string') {
      throw new ParseError(`${site} "headers" key "${key}" must be a string`, {
        file,
        key: 'headers',
      })
    }
    const lower = key.toLowerCase()
    if (lower === 'host') {
      throw new ParseError(`${site} "headers" must not set "Host"`, { file, key: 'headers' })
    }
    if (secretHeader !== undefined && lower === secretHeader.toLowerCase()) {
      throw new ParseError(
        `${site} "headers" must not set "${key}": that header is set from "secret"`,
        { file, key: 'headers' },
      )
    }
    out[key] = value
  }
  return out
}
