/** The `Host` allowlist: a page on a hostile name rebound to this machine must not read the door. */
import { isIP } from 'node:net'
import { hostname } from 'node:os'
import { isRecord } from './records.ts'

const TAILSCALE_TIMEOUT_MS = 2000
/** How long a tailnet probe's answer stands, so a hostile `Host` cannot spawn one per request. */
const TAILSCALE_RETRY_MS = 60_000
const PORT_SUFFIX_RE = /:\d*$/
const TRAILING_DOT_RE = /\.$/
/** Stable for the process's life: `hostname()` does not change under a running unit. */
let hostnameNames: Set<string> | undefined
/** The tailnet name, and when the probe ran; `name` undefined is a probe that found none. */
let tailnet: { name: string | undefined; at: number } | undefined

function bareHost(authority: string): string {
  if (!authority.startsWith('[')) {
    return authority.replace(PORT_SUFFIX_RE, '').toLowerCase().replace(TRAILING_DOT_RE, '')
  }
  const close = authority.indexOf(']')
  // `Host: [::1` has no close bracket. `slice(1, -1)` would then hand back
  // `::`, which `isIP` accepts as a valid literal -- a malformed authority
  // must not become one.
  if (close === -1) {
    return ''
  }
  return authority.slice(1, close).toLowerCase()
}

function ownNames(): Set<string> {
  if (hostnameNames === undefined) {
    const full = hostname().toLowerCase()
    hostnameNames = new Set([full, full.split('.')[0] ?? full])
  }
  return hostnameNames
}

/**
 * The tailnet MagicDNS name, when `tailscale` answers with one.
 *
 * The unit can boot before `tailscale` is up, so a probe that found nothing is
 * not the machine's final set of names. The cache is time-bounded rather than
 * final: a name that appears later is picked up on the next miss past the
 * cooldown, and a name that changes (a tailscaled restart) likewise. Only a
 * `Host` that already missed reaches this, and a warm cache answers it without
 * a spawn, so a hostile name costs one probe per cooldown rather than one per
 * request.
 */
function tailnetName(): string | undefined {
  const now = Date.now()
  if (tailnet !== undefined && now - tailnet.at < TAILSCALE_RETRY_MS) {
    return tailnet.name
  }
  let name: string | undefined
  try {
    const out = Bun.spawnSync(['tailscale', 'status', '--json'], {
      timeout: TAILSCALE_TIMEOUT_MS,
      stderr: 'ignore',
    })
    const parsed: unknown = JSON.parse(out.stdout.toString())
    const self = isRecord(parsed) ? parsed.Self : undefined
    const dns = isRecord(self) ? self.DNSName : undefined
    if (typeof dns === 'string' && dns !== '') {
      name = bareHost(dns)
    }
  } catch {
    // No tailscale yet, or it is not up: retried after the cooldown.
  }
  tailnet = { name, at: now }
  return name
}

/** A missing `Host` (HTTP/1.0) is allowed; so are IP literals, `localhost`, `*.localhost`, this machine's names, and `allowed`. */
export function isAllowedHost(
  authority: string | null | undefined,
  allowed: readonly string[],
): boolean {
  if (authority === null || authority === undefined || authority === '') {
    return true
  }
  const host = bareHost(authority)
  return (
    isIP(host) !== 0 ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    allowed.includes(host) ||
    ownNames().has(host) ||
    tailnetName() === host
  )
}

export const HOST_REFUSAL = (authority: string): string =>
  `Host "${authority}" is not allowed; add its name to allowed_hosts in the config`
