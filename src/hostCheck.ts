/** The `Host` allowlist: a page on a hostile name rebound to this machine must not read the door. */
import { isIP } from 'node:net'
import { hostname } from 'node:os'

const TAILSCALE_TIMEOUT_MS = 2000
const PORT_SUFFIX_RE = /:\d*$/
const TRAILING_DOT_RE = /\.$/
let machineNames: Set<string> | undefined

function bareHost(authority: string): string {
  const host = authority.startsWith('[')
    ? authority.slice(1, authority.indexOf(']'))
    : authority.replace(PORT_SUFFIX_RE, '')
  return host.toLowerCase().replace(TRAILING_DOT_RE, '')
}

/** This machine's own names, read once, on the first non-IP request: its hostname, the short form, and the tailnet MagicDNS name when `tailscale` answers. */
function machineHostNames(): Set<string> {
  if (machineNames === undefined) {
    const full = hostname().toLowerCase()
    machineNames = new Set([full, full.split('.')[0] ?? full])
    try {
      const out = Bun.spawnSync(['tailscale', 'status', '--json'], {
        timeout: TAILSCALE_TIMEOUT_MS,
        stderr: 'ignore',
      })
      const dns = (JSON.parse(out.stdout.toString()) as { Self?: { DNSName?: unknown } }).Self
        ?.DNSName
      if (typeof dns === 'string' && dns !== '') {
        machineNames.add(bareHost(dns))
      }
    } catch {
      // no tailscale on this machine
    }
  }
  return machineNames
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
    machineHostNames().has(host)
  )
}

export const HOST_REFUSAL = (authority: string): string =>
  `Host "${authority}" is not allowed; add its name to allowed_hosts in the config`
