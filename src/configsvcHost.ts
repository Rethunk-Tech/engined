/** Where the config UI is reached: always a loopback listener, plus an HTTPS bridge on `[configsvc] host` when that is not loopback. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateDir } from './paths.ts'

/** The port the Caddy bridge serves the config UI on, on the name `[configsvc] host` gives. */
export const CONFIGSVC_TLS_PORT = 29_444

/** Caddy sets this on the loopback hop; configsvc trusts `X-Forwarded-For` only when it matches. */
export const BRIDGE_HOP_HEADER = 'X-Engined-Hop'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const BRIDGE_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/

export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTS.has(host)

/** A name or IPv4 address a client can dial and a Caddy site address can carry; `0.0.0.0` names no one machine. */
export const isBridgeHost = (host: string): boolean =>
  host !== '0.0.0.0' && BRIDGE_HOST_RE.test(host)

/** The `host:port` clients use through the bridge, which is also the `Host` header they send. */
export const bridgeAuthority = (host: string): string => `${host}:${CONFIGSVC_TLS_PORT}`

const bridgeHopFile = (): string => join(stateDir(), 'caddy', 'configsvc-hop')

/** Create-or-read the hop secret both the Caddyfile and the config UI share. */
export function ensureBridgeHop(file = bridgeHopFile()): string {
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing !== '') {
      return existing
    }
  } catch {
    // First writer creates it; a racing reader takes the wx-fallback below.
  }
  const secret = randomBytes(32).toString('hex')
  mkdirSync(dirname(file), { recursive: true })
  try {
    writeFileSync(file, `${secret}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return secret
  } catch {
    return readFileSync(file, 'utf8').trim()
  }
}

export function hopMatches(expected: string | undefined, header: string | null): boolean {
  if (expected === undefined || header === null) {
    return false
  }
  const left = Buffer.from(expected)
  const right = Buffer.from(header)
  return left.length === right.length && timingSafeEqual(left, right)
}
