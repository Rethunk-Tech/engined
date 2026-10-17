import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startConfigsvc } from './configsvc.ts'
import { SESSION_IDLE_MS } from './configsvcAuth.ts'
import { CONFIGSVC_TLS_PORT } from './configsvcHost.ts'
import { bindDualFamily } from './listen.ts'
import { createDoor } from './main.ts'
import { BUNX, config, deadPort, ENGINES_ROOT, makeTestRoot } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-configsvc-')
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanups.splice(0)) {
    stop()
  }
})

/** A real config dir, a real in-process door as engined, and the config UI over them; only the three host tools are fakes. */
async function harness(opts: { passwordHash?: string; bridgeHost?: string } = {}) {
  const dir = mkdtempSync(join(TEST_ROOT, 'cfg-'))
  const configFile = join(dir, 'config.toml')
  const doorPort = deadPort()
  writeFileSync(configFile, `listen_port = ${doorPort}\n`)
  const door = createDoor(
    config({ listen_port: doorPort }),
    { enginesRoot: ENGINES_ROOT, bunx: BUNX },
    { usageStateRoot: join(dir, 'usage') },
  )
  const bound = bindDualFamily(door.fetch, doorPort)
  const audit: string[] = []
  const reloads: string[] = []
  const clock = { now: 1_000_000 }
  const svc = startConfigsvc(
    { port: 0, passwordHash: opts.passwordHash, bridgeHost: opts.bridgeHost, now: () => clock.now },
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
      },
      audit: (line) => audit.push(line),
      fetch,
      doctor: async () => ({ ok: true, checks: [] }),
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
  return { dir, configFile, svc, call, signIn, audit, reloads, clock, doorPort }
}

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
  expect((await login('hunter2')).status).toBe(429)
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
  expect(readdirSync(h.dir).sort()).toEqual(
    ['.history', 'config.toml', 'usage'].filter((n) => existsSync(join(h.dir, n))).sort(),
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

  const route = await post('/api/validate', {
    text: '[[engine]]\nid = "e"\n[[route]]\nengine = "e"\nbogus = 1\n',
  })
  expect(route.ok).toBe(false)
  expect(route.errors?.[0]?.path).toMatchObject({ table: 'route', index: 0, key: 'bogus' })
  expect(route.errors?.[0]?.message).toContain('config.toml')

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
