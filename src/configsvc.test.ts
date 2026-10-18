import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { startConfigsvc } from './configsvc.ts'
import { readJson } from './configsvcApi.ts'
import { SESSION_IDLE_MS } from './configsvcAuth.ts'
import { BRIDGE_HOP_HEADER, CONFIGSVC_TLS_PORT } from './configsvcHost.ts'
import type { DoctorReport } from './doctor.ts'
import {
  MAX_JSON_BODY_BYTES,
  STATUS_INTERNAL_SERVER_ERROR,
  STATUS_METHOD_NOT_ALLOWED,
  STATUS_PAYLOAD_TOO_LARGE,
} from './http.ts'
import { bindDualFamily } from './listen.ts'
import { createDoor } from './main.ts'
import {
  BUNX,
  config,
  deadPort,
  ENGINES_ROOT,
  engine,
  makeTestRoot,
  route,
  writeEngineSpec,
} from './test-support.ts'
import type { Config } from './types.ts'

const TEST_ROOT = makeTestRoot('engined-configsvc-')
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanups.splice(0)) {
    stop()
  }
})

/** A real config dir, a real in-process door as engined, and the config UI over them; only the three host tools are fakes. */
async function harness(
  opts: {
    passwordHash?: string
    bridgeHost?: string
    bridgeHop?: string
    doorConfig?: Partial<Config>
    doctor?: () => Promise<DoctorReport>
  } = {},
) {
  const dir = mkdtempSync(join(TEST_ROOT, 'cfg-'))
  const configFile = join(dir, 'config.toml')
  const doorPort = deadPort()
  writeFileSync(configFile, `listen_port = ${doorPort}\n`)
  const door = createDoor(
    config({ listen_port: doorPort, ...opts.doorConfig }),
    {
      enginesRoot: ENGINES_ROOT,
      bunx: BUNX,
      exec: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
    },
    { usageStateRoot: join(dir, 'usage') },
  )
  const bound = bindDualFamily(door.fetch, doorPort)
  const audit: string[] = []
  const reloads: string[] = []
  const doorPaths: string[] = []
  const clock = { now: 1_000_000 }
  const svc = startConfigsvc(
    {
      port: 0,
      passwordHash: opts.passwordHash,
      bridgeHost: opts.bridgeHost,
      bridgeHop: opts.bridgeHop,
      now: () => clock.now,
    },
    {
      configFile,
      enginesRoot: ENGINES_ROOT,
      bunx: BUNX,
      stateRoot: join(dir, 'state'),
      doorUrl: () => `http://127.0.0.1:${doorPort}`,
      reload: async (signal) => {
        reloads.push(signal)
        return { ok: true }
      },
      secrets: {
        present: async (service) => service === 'have',
        store: async () => ({ ok: true }),
        clear: async () => ({ ok: true }),
      },
      audit: (line) => audit.push(line),
      fetch: Object.assign(
        (input: string | Request | URL, init?: RequestInit) => {
          doorPaths.push(new URL(String(input)).pathname)
          return fetch(input, init)
        },
        { preconnect: fetch.preconnect },
      ),
      doctor: opts.doctor ?? (async () => ({ ok: true, checks: [] })),
    },
  )
  cleanups.push(() => {
    svc.stop()
    bound.v4.stop(true)
    bound.v6?.stop(true)
  })
  const base = `http://127.0.0.1:${svc.port}`
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        ...(init.cookie ? { cookie: init.cookie } : {}),
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  const signIn = async (): Promise<string> => {
    const res = await call('/login', { method: 'POST', body: JSON.stringify({ token: svc.token }) })
    return (res.headers.get('set-cookie') as string).split(';')[0] as string
  }
  return { dir, configFile, svc, call, signIn, audit, reloads, clock, doorPort, doorPaths }
}

test('a JSON body past the door cap is 413 before it is parsed', async () => {
  const req = new Request('http://configsvc.local/', {
    method: 'POST',
    headers: { 'content-length': String(MAX_JSON_BODY_BYTES + 1) },
  })
  const result = await readJson(req)
  expect(result).toBeInstanceOf(Response)
  expect((result as Response).status).toBe(STATUS_PAYLOAD_TOO_LARGE)
})

test('an unhandled throw answers 500 without the error text', async () => {
  const h = await harness({
    doctor: async () => {
      throw new Error('secret token xyz')
    },
  })
  const cookie = await h.signIn()
  const res = await h.call('/api/doctor', { cookie })
  expect(res.status).toBe(STATUS_INTERNAL_SERVER_ERROR)
  const body = await res.text()
  expect(body).toContain('internal error')
  expect(body).not.toContain('secret token xyz')
})

test('a minted token signs in once, the session slides for 12 hours and logout ends it', async () => {
  const h = await harness()
  expect((await h.call('/api/config')).status).toBe(401)
  const wrong = await h.call('/login', { method: 'POST', body: JSON.stringify({ token: '00' }) })
  expect(wrong.status).toBe(401)

  const exchanged = await h.call('/login', {
    method: 'POST',
    body: JSON.stringify({ token: h.svc.token }),
  })
  expect(exchanged.status).toBe(200)
  const setCookie = exchanged.headers.get('set-cookie') as string
  expect(setCookie).toContain('HttpOnly')
  expect(setCookie).toContain('SameSite=Strict')
  expect(exchanged.headers.get('x-frame-options')).toBe('DENY')
  expect(exchanged.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
  expect(exchanged.headers.get('cross-origin-opener-policy')).toBe('same-origin')
  expect(exchanged.headers.get('permissions-policy')).toBe(
    'camera=(), microphone=(), geolocation=()',
  )
  const cookie = setCookie.split(';')[0] as string

  expect((await h.call('/nothing', { cookie })).status).toBe(404)
  const shell = await h.call('/')
  expect(shell.status).toBe(200)
  expect(await shell.text()).toContain('id="app"')
  h.clock.now += SESSION_IDLE_MS - 1000
  expect((await h.call('/api/config', { cookie })).status).toBe(200)
  h.clock.now += SESSION_IDLE_MS - 1000
  expect((await h.call('/api/config', { cookie })).status).toBe(200)
  await h.call('/logout', { method: 'POST', cookie })
  expect((await h.call('/api/config', { cookie })).status).toBe(401)

  const again = await h.signIn()
  const foreign = await h.call('/api/config', {
    cookie: again,
    headers: { Origin: 'http://evil.example' },
  })
  expect(foreign.status).toBe(403)
  h.clock.now += SESSION_IDLE_MS + 1000
  expect((await h.call('/api/config', { cookie: again })).status).toBe(401)
})

test('a known configsvc path asked with the wrong method is 405', async () => {
  const h = await harness()
  const cookie = await h.signIn()
  const postConfig = await h.call('/api/config', { method: 'POST', cookie, body: '{}' })
  expect(postConfig.status).toBe(STATUS_METHOD_NOT_ALLOWED)
  expect(postConfig.headers.get('allow')).toContain('GET')
  const getSave = await h.call('/api/save', { cookie })
  expect(getSave.status).toBe(STATUS_METHOD_NOT_ALLOWED)
  expect(getSave.headers.get('allow')).toContain('POST')
  expect((await h.call('/api/no-such-route', { cookie })).status).toBe(404)
})

test('an upstream Enable/Disable header writes true and Enable drops the key', async () => {
  const src = readFileSync(join(import.meta.dir, 'configsvc/ui/upstreams.tsx'), 'utf8')
  expect(src).toContain("path: ['upstream', index, 'disable']")
  expect(src).toContain('value: upstream.disable === true ? undefined : true')
  const h = await harness()
  const cookie = await h.signIn()
  const post = async (text: string, value: unknown) =>
    (
      await h.call('/api/edit', {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          text,
          ops: [{ op: 'setKey', path: ['upstream', 0, 'disable'], value }],
        }),
      })
    ).json() as Promise<{ text: string }>
  const base = 'listen_port = 1\n\n[[upstream]]\nid = "u"\negress = "none"\n'
  const disabled = await post(base, true)
  expect(disabled.text).toContain('disable = true')
  const enabled = await post(disabled.text, undefined)
  expect(enabled.text).not.toContain('disable')
})

test('settings potluck writes a loadable table only when every required field is set', async () => {
  const h = await harness()
  const cookie = await h.signIn()
  const html = await (await h.call('/')).text()
  const script = [...html.matchAll(/src="([^"]+)"/g)]
    .map((m) => m[1] as string)
    .find((s) => s.endsWith('.js'))
  expect(script).toBeDefined()
  const js = await (
    await h.call(
      script?.startsWith('/') ? (script as string) : `/${(script as string).replace(/^\.\//, '')}`,
    )
  ).text()
  expect(js).toContain('Potluck')

  const post = async (path: string, body: unknown) =>
    (await h.call(path, { method: 'POST', cookie, body: JSON.stringify(body) })).json() as Promise<{
      ok?: boolean
      text?: string
    }>
  const read = (await (await h.call('/api/config', { cookie })).json()) as {
    text: string
    sha256: string
  }
  const saved = await h.call('/api/save', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ text: read.text, base_sha256: read.sha256 }),
  })
  expect(saved.status).toBe(200)
  expect(readFileSync(h.configFile, 'utf8')).not.toContain('[potluck]')

  const incomplete = await post('/api/validate', {
    text: `listen_port = ${h.doorPort}\n[potluck]\ncallback_url = "https://potluck.example/c"\n`,
  })
  expect(incomplete.ok).toBe(false)

  const written = await post('/api/edit', {
    text: `listen_port = ${h.doorPort}\n`,
    ops: [
      {
        op: 'setKey',
        path: ['potluck'],
        value: {
          callback_url: 'https://potluck.example/c',
          callback_secret: { service: 'potluck', username: 'callback' },
        },
      },
    ],
  })
  writeFileSync(h.configFile, written.text as string)
  expect(loadConfig(h.configFile, ENGINES_ROOT).potluck).toEqual({
    url: 'https://potluck.example/c',
    secret: { service: 'potluck', username: 'callback' },
  })
  const listed = (await (await h.call('/api/secrets', { cookie })).json()) as {
    secrets: { service: string }[]
  }
  expect(listed.secrets).toEqual([])
  const stored = await h.call('/api/secret', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ service: 'potluck', username: 'callback', value: 'tok' }),
  })
  expect(stored.status).toBe(200)
  const cleared = await h.call('/api/secret/clear', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ service: 'potluck', username: 'callback' }),
  })
  expect(cleared.status).toBe(200)
})

test('with a password hash, login works until five failures a minute lock the client out', async () => {
  const hash = await Bun.password.hash('hunter2', { algorithm: 'argon2id' })
  const h = await harness({ passwordHash: hash })
  expect(h.svc.token).toBeUndefined()
  expect(h.svc.logLine).not.toContain('token=')
  const login = (password: string) =>
    h.call('/login', { method: 'POST', body: JSON.stringify({ password }) })
  for (let i = 0; i < 5; i++) {
    expect((await login('wrong')).status).toBe(401)
  }
  const locked = await login('hunter2')
  expect(locked.status).toBe(429)
  expect(locked.headers.get('Retry-After')).toBe('60')
  h.clock.now += 61_000
  const ok = await login('hunter2')
  expect(ok.status).toBe(200)
  const cookie = (ok.headers.get('set-cookie') as string).split(';')[0] as string
  expect((await h.call('/api/history', { cookie })).status).toBe(200)
})

test('save refuses a stale base, then writes atomically with history and one audit line', async () => {
  const h = await harness()
  const cookie = await h.signIn()
  const read = async () =>
    (await (await h.call('/api/config', { cookie })).json()) as { text: string; sha256: string }
  const first = await read()
  const edited = `${first.text}# edited\nchat_timeout_seconds = 30\n`
  const save = (text: string, base: string) =>
    h.call('/api/save', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ text, base_sha256: base }),
    })

  const saved = await save(edited, first.sha256)
  expect(saved.status).toBe(200)
  const result = (await saved.json()) as {
    sha256: string
    restart: string[]
    hard_reload_needed: boolean
  }
  expect(result.hard_reload_needed).toBe(false)
  expect(readFileSync(h.configFile, 'utf8')).toBe(edited)
  expect((await read()).sha256).toBe(result.sha256)
  expect(readdirSync(h.dir).sort((a, b) => a.localeCompare(b))).toEqual(
    ['.history', 'config.toml', 'usage']
      .filter((n) => existsSync(join(h.dir, n)))
      .sort((a, b) => a.localeCompare(b)),
  )
  const history = readdirSync(join(h.dir, '.history'))
  expect(history).toHaveLength(1)
  expect(readFileSync(join(h.dir, '.history', history[0] as string), 'utf8')).toBe(first.text)
  expect(h.audit).toHaveLength(1)
  expect(h.audit[0]).toMatch(
    /^configsvc: audit \d{4}-.*client=127\.0\.0\.1 changed=top:chat_timeout_seconds before=[0-9a-f]{64} after=[0-9a-f]{64}$/,
  )

  const entry = (await (await h.call(`/api/history/${history[0]}`, { cookie })).json()) as {
    text: string
  }
  expect(entry.text).toBe(first.text)
  expect((await h.call('/api/history/config-19990101T000000Z.toml', { cookie })).status).toBe(404)
  expect((await h.call('/api/history/..%2Fconfig.toml', { cookie })).status).toBe(404)

  const stale = await save(`${edited}# lost\n`, first.sha256)
  expect(stale.status).toBe(409)
  expect(((await stale.json()) as { text: string }).text).toBe(edited)
  expect(readFileSync(h.configFile, 'utf8')).toBe(edited)

  const invalid = await save('listen_port = "x"\n', result.sha256)
  expect(invalid.status).toBe(422)
  expect(readFileSync(h.configFile, 'utf8')).toBe(edited)

  const moved = await save(
    edited.replace(`listen_port = ${h.doorPort}`, `listen_port = ${deadPort()}`),
    result.sha256,
  )
  expect(((await moved.json()) as { hard_reload_needed: boolean }).hard_reload_needed).toBe(true)
})

interface Reply {
  ok?: boolean
  errors?: { message: string; file?: string; line?: number; path?: unknown }[]
  text?: string
  diff?: string
}

test('validate names the file, position and config path of a fault; edit, reload, secrets and status work', async () => {
  const h = await harness()
  const cookie = await h.signIn()
  const post = async (path: string, body: unknown) =>
    (
      await h.call(path, { method: 'POST', cookie, body: JSON.stringify(body) })
    ).json() as Promise<Reply>

  const validated = await post('/api/validate', {
    text: '[[engine]]\nid = "e"\n[[route]]\nengine = "e"\nbogus = 1\n',
  })
  expect(validated.ok).toBe(false)
  expect(validated.errors?.[0]?.path).toMatchObject({ table: 'route', index: 0, key: 'bogus' })
  expect(validated.errors?.[0]?.message).toContain('config.toml')

  const syntax = await post('/api/validate', { text: 'a = 1\nb = = 2\n' })
  expect(syntax.errors?.[0]).toMatchObject({ line: 2 })
  expect(syntax.errors?.[0]?.file).toBe(h.configFile)

  const edit = await post('/api/edit', {
    text: '# keep\nlisten_port = 29200\n',
    ops: [{ op: 'setKey', path: ['listen_port'], value: 29_201 }],
  })
  expect(edit.text).toBe('# keep\nlisten_port = 29201\n')
  expect(edit.diff).toContain('-listen_port = 29200')

  const deps = (await post('/api/dependents', {
    text: '[[engine]]\nid = "e"\n[[route]]\nengine = "e"\nmodel = "m"\n',
    table: 'engine',
    id: 'e',
  })) as unknown as { dependents: string[] }
  expect(deps.dependents).toEqual(['route[0].engine'])

  expect(await post('/api/reload', { mode: 'hard' })).toEqual({ ok: true })
  expect(h.reloads).toEqual(['USR1'])
  const refresh = await h.call('/api/inventory', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ upstream: 'nobody' }),
  })
  expect(refresh.status).toBe(404)

  const shipped = (await (await h.call('/api/shipped', { cookie })).json()) as {
    engines: { id: string; kind: string; models_dir?: string; devices: string[] }[]
  }
  const llama = shipped.engines.find((e) => e.id === 'llama')
  expect(llama).toMatchObject({
    kind: 'openai-http',
    models_dir: '~/.local/share/engined-models/llm',
  })
  expect(llama?.devices).toContain('/dev/dri')
  expect(shipped.engines.find((e) => e.id === 'claude')).toMatchObject({ kind: 'agentic-cli' })
  expect((await h.call('/api/logs/nobody?tail=5', { cookie })).status).toBe(404)
  expect((await h.call('/api/resources/nobody', { cookie })).status).toBe(404)

  const status = (await (await h.call('/api/status', { cookie })).json()) as { contract: number }
  expect(status.contract).toBeNumber()
})

test('behind the TLS bridge the bridged Host and https Origin are accepted, cookies are Secure, and the log line is https', async () => {
  const h = await harness({ bridgeHost: 'engined.lan' })
  expect(h.svc.logLine).toContain(`https://engined.lan:${CONFIGSVC_TLS_PORT}/?token=`)
  const bridged = { Host: `engined.lan:${CONFIGSVC_TLS_PORT}`, 'X-Forwarded-For': '192.168.1.9' }
  const login = await h.call('/login', {
    method: 'POST',
    body: JSON.stringify({ token: h.svc.token }),
    headers: { ...bridged, Origin: `https://engined.lan:${CONFIGSVC_TLS_PORT}` },
  })
  expect(login.status).toBe(200)
  const setCookie = login.headers.get('set-cookie') as string
  expect(setCookie).toContain('Secure')
  const cookie = setCookie.split(';')[0] as string
  expect((await h.call('/api/history', { cookie, headers: bridged })).status).toBe(200)
  // A bridged Host with the plain-http Origin, another name, or a loopback Host dressed with the bridge Origin is refused.
  const refuse = (headers: Record<string, string>) => h.call('/api/history', { cookie, headers })
  expect(
    (await refuse({ ...bridged, Origin: `http://engined.lan:${CONFIGSVC_TLS_PORT}` })).status,
  ).toBe(403)
  expect((await refuse({ Host: `evil.example:${CONFIGSVC_TLS_PORT}` })).status).toBe(403)
  expect((await h.call('/api/history', { cookie })).status).toBe(200)
})

test('X-Forwarded-For keys lockout only when Caddy set the hop header', async () => {
  const hop = 'bridge-hop-secret'
  const h = await harness({ bridgeHost: 'engined.lan', bridgeHop: hop })
  const origin = `https://engined.lan:${CONFIGSVC_TLS_PORT}`
  const host = `engined.lan:${CONFIGSVC_TLS_PORT}`
  const attempt = (xff: string, hopHeader?: string) =>
    h.call('/login', {
      method: 'POST',
      body: JSON.stringify({ token: 'wrong' }),
      headers: {
        Host: host,
        Origin: origin,
        'X-Forwarded-For': xff,
        ...(hopHeader === undefined ? {} : { [BRIDGE_HOP_HEADER]: hopHeader }),
      },
    })
  for (let i = 0; i < 5; i++) {
    expect((await attempt(`10.0.0.${i + 1}`)).status).toBe(401)
  }
  expect((await attempt('10.0.0.9')).status).toBe(429)
  for (let i = 0; i < 5; i++) {
    expect((await attempt(`11.0.0.${i + 1}`, hop)).status).toBe(401)
  }
  expect((await attempt('11.0.0.9', hop)).status).toBe(401)
})

test('route Test calls the verb the route serves, never chat, and says so when the door lacks the address', async () => {
  const specs = mkdtempSync(join(TEST_ROOT, 'specs-'))
  writeEngineSpec(
    specs,
    'voice',
    `kind = "tts"
upstream = "self"
image = "test-tts:local"
obtain = "pull"
serves = ["/openai/v1/audio/speech"]
command = []

[ready]
path = "/health"
status = 200
`,
  )
  const h = await harness({
    doorConfig: {
      engines: [engine({ id: 'voice', spec_dir: join(specs, 'voice') })],
      routes: [route({ engine: 'voice', model: undefined, upstream: 'local' })],
    },
  })
  const cookie = await h.signIn()
  const probeRoute = async (address: string) => {
    const res = await h.call('/api/test-route', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ address }),
    })
    return (await res.json()) as { status: number; error?: string }
  }

  const tts = await probeRoute('@/voice/local')
  expect(h.doorPaths).toContain('/openai/v1/audio/speech')
  expect(h.doorPaths).not.toContain('/openai/v1/chat/completions')
  expect(tts.error ?? '').not.toContain('does not serve')

  const missing = await probeRoute('@/nothing/local')
  expect(missing).toMatchObject({
    status: 0,
    error: 'not on the running door; save and reload first',
  })
})
