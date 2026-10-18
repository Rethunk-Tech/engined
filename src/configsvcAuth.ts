/** Login for the config UI: a minted token or a password hash, sessions, and a failure rate limit. */
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'engined_configsvc'
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000
const MAX_FAILURES = 5
const FAILURE_WINDOW_MS = 60_000

interface Auth {
  /** The one-time token, when no password hash is configured. */
  token: string | undefined
  /** A session id for a correct secret, `'limited'` when this client has failed too often, else `undefined`. */
  login: (secret: string, client: string) => Promise<string | 'limited' | undefined>
  /** Whether the Cookie header carries a live session; a live one is renewed. */
  authorize: (cookieHeader: string | null) => boolean
  logout: (cookieHeader: string | null) => void
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function sessionIdOf(cookieHeader: string | null): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === SESSION_COOKIE) {
      return value.join('=')
    }
  }
  return undefined
}

export function createAuth(opts: { passwordHash?: string; now?: () => number }): Auth {
  const now = opts.now ?? Date.now
  const token = opts.passwordHash === undefined ? randomBytes(16).toString('hex') : undefined
  const lastSeen = new Map<string, number>()
  const failures = new Map<string, number[]>()

  const sweep = (): void => {
    const t = now()
    for (const [id, seen] of lastSeen) {
      if (t - seen > SESSION_IDLE_MS) {
        lastSeen.delete(id)
      }
    }
    for (const [client, at] of failures) {
      const recent = at.filter((when) => t - when < FAILURE_WINDOW_MS)
      if (recent.length === 0) {
        failures.delete(client)
      } else {
        failures.set(client, recent)
      }
    }
  }

  const limited = (client: string): boolean => {
    const recent = (failures.get(client) ?? []).filter((at) => now() - at < FAILURE_WINDOW_MS)
    if (recent.length === 0) {
      failures.delete(client)
    } else {
      failures.set(client, recent)
    }
    return recent.length >= MAX_FAILURES
  }

  return {
    token,
    async login(secret, client) {
      sweep()
      if (limited(client)) {
        return 'limited'
      }
      const ok =
        token === undefined
          ? await Bun.password.verify(secret, opts.passwordHash as string).catch(() => false)
          : sameSecret(secret, token)
      if (!ok) {
        failures.set(client, [...(failures.get(client) ?? []), now()])
        return
      }
      const id = randomBytes(16).toString('hex')
      lastSeen.set(id, now())
      return id
    },
    authorize(cookieHeader) {
      sweep()
      const id = sessionIdOf(cookieHeader)
      const seen = id === undefined ? undefined : lastSeen.get(id)
      if (id === undefined || seen === undefined) {
        return false
      }
      if (now() - seen > SESSION_IDLE_MS) {
        lastSeen.delete(id)
        return false
      }
      lastSeen.set(id, now())
      return true
    },
    logout(cookieHeader) {
      const id = sessionIdOf(cookieHeader)
      if (id !== undefined) {
        lastSeen.delete(id)
      }
    },
  }
}
