/** The config UI's HTTP server: origin checks, login, sessions, and the JSON API behind them. */

import page from './configsvc/ui/index.html'
import { type ConfigsvcDeps, configApi } from './configsvcApi.ts'
import { createAuth, SESSION_COOKIE, SESSION_IDLE_MS } from './configsvcAuth.ts'
import { CONFIGSVC_URL_PREFIX } from './configsvcCli.ts'
import { liveApi } from './configsvcLive.ts'
import {
  jsonError,
  STATUS_FORBIDDEN,
  STATUS_NOT_FOUND,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_UNAUTHORIZED,
} from './http.ts'

const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1'])
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
}

export interface ConfigsvcOptions {
  host: string
  /** 0 picks a free port; the bound one is on the result. */
  port: number
  passwordHash?: string
  now?: () => number
}

export interface StartedConfigsvc {
  port: number
  /** The line to log: `${CONFIGSVC_URL_PREFIX}<url>`, carrying the token when no password hash is set. */
  logLine: string
  url: string
  token: string | undefined
  stop: () => void
}

/**
 * Host and Origin, as the door checks them: a page on another origin, or a
 * request addressed to a name that is not this listener's, is refused. A
 * listener bound beyond loopback is meant to be reached by name, so there the
 * Host must only agree with the Origin.
 */
function refuseForeign(req: Request, bindHost: string, port: number): Response | undefined {
  const site = req.headers.get('Sec-Fetch-Site')
  const host = req.headers.get('Host')
  const origin = req.headers.get('Origin')
  if (site !== null && site !== 'none' && site !== 'same-origin') {
    return jsonError(STATUS_FORBIDDEN, 'cross-origin requests are refused')
  }
  if (origin !== null && origin !== `http://${host}`) {
    return jsonError(STATUS_FORBIDDEN, 'cross-origin requests are refused')
  }
  const loopback = LOOPBACK_BINDS.has(bindHost)
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  if (loopback && host !== null && !allowed.includes(host)) {
    return jsonError(STATUS_FORBIDDEN, `Host "${host}" is outside the loopback set`)
  }
  return undefined
}

function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_IDLE_MS / 1000}`
}

function withHeaders(res: Response): Response {
  const headers = new Headers(res.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value)
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export function startConfigsvc(opts: ConfigsvcOptions, deps: ConfigsvcDeps): StartedConfigsvc {
  const auth = createAuth({ passwordHash: opts.passwordHash, now: opts.now })

  const exchange = async (
    secret: string,
    client: string,
  ): Promise<{ cookie?: string; refusal?: Response }> => {
    const session = await auth.login(secret, client)
    if (session === 'limited') {
      return {
        refusal: jsonError(STATUS_TOO_MANY_REQUESTS, 'too many failed attempts; wait a minute'),
      }
    }
    return session === undefined
      ? { refusal: jsonError(STATUS_UNAUTHORIZED, 'wrong credentials') }
      : { cookie: sessionCookie(session) }
  }

  /** The one unauthenticated API route: `POST /login`. The shell page and its assets are served by Bun's route table before this runs, and the page exchanges a `?token=` link through this route. */
  async function signIn(req: Request, url: URL, client: string): Promise<Response | undefined> {
    if (req.method !== 'POST' || url.pathname !== '/login') {
      return undefined
    }
    const body = (await req.json().catch(() => ({}))) as { password?: unknown; token?: unknown }
    const secret = auth.token === undefined ? body.password : body.token
    const done = await exchange(typeof secret === 'string' ? secret : '', client)
    return (
      done.refusal ??
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json', 'set-cookie': done.cookie as string },
      })
    )
  }

  async function handle(req: Request, client: string): Promise<Response> {
    const url = new URL(req.url)
    const refusal = refuseForeign(req, opts.host, server.port as number)
    if (refusal !== undefined) {
      return refusal
    }
    const signedIn = await signIn(req, url, client)
    if (signedIn !== undefined) {
      return signedIn
    }
    const cookie = req.headers.get('Cookie')
    if (!auth.authorize(cookie)) {
      return jsonError(STATUS_UNAUTHORIZED, 'sign in first')
    }
    if (req.method === 'POST' && url.pathname === '/logout') {
      auth.logout(cookie)
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          'content-type': 'application/json',
          'set-cookie': `${SESSION_COOKIE}=; Max-Age=0; Path=/`,
        },
      })
    }
    const info = { client }
    const routed =
      (await configApi(req, url.pathname, deps, info)) ?? (await liveApi(req, url.pathname, deps))
    return routed ?? jsonError(STATUS_NOT_FOUND, 'not found')
  }

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0,
    routes: { '/': page },
    async fetch(req, srv) {
      try {
        return withHeaders(await handle(req, srv.requestIP(req)?.address ?? 'unknown'))
      } catch (err) {
        return withHeaders(jsonError(500, err instanceof Error ? err.message : String(err)))
      }
    },
  })
  const port = server.port as number
  const url = `http://${opts.host}:${port}/`
  const shown = auth.token === undefined ? url : `${url}?token=${auth.token}`
  return {
    port,
    url,
    token: auth.token,
    logLine: `${CONFIGSVC_URL_PREFIX}${shown}`,
    stop: () => server.stop(true),
  }
}
