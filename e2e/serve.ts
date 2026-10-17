/**
 * A scratch engined door and the config UI over a copy of config.example.toml, for the smoke test.
 * Nothing here touches the real unit: reloads signal the scratch door's own pid.
 * Prints `READY <json>` once both listen; stops both on SIGTERM.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { startConfigsvc } from '../src/configsvc.ts'
import { secretTool } from '../src/configsvcSecrets.ts'
import { runDoctor } from '../src/doctor.ts'

const repo = join(import.meta.dir, '..')

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

const root = mkdtempSync(join('/var/tmp', 'engined-e2e-'))
const configDir = join(root, 'config', 'engined')
const models = join(root, 'models')
mkdirSync(configDir, { recursive: true })
const doorPort = await freePort()
const cursorPort = await freePort()

const example = readFileSync(join(repo, 'config.example.toml'), 'utf8')
for (const [, file] of example.matchAll(/filename\s*=\s*"([^"]+)"/g)) {
  const full = join(models, file as string)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, '')
}
const configFile = join(configDir, 'config.toml')
const uiPort = await freePort()
writeFileSync(
  configFile,
  `${example
    .replace(
      /models_dir\s*=\s*"~\/\.local\/share\/engined-models\/[a-z]+"/g,
      `models_dir = "${models}"`,
    )
    .replace(
      /^listen_port = \d+/m,
      `listen_port = ${doorPort}\ncursor_port = ${cursorPort}`,
    )}\n[configsvc]\nenable = true\nport = ${uiPort}\n`,
)

const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_STATE_HOME: join(root, 'state'),
  XDG_DATA_HOME: join(root, 'data'),
  ENGINED_INSTALL_DIR: repo,
}
const door = Bun.spawn(['bun', join(repo, 'src', 'main.ts')], {
  env,
  stdout: 'inherit',
  stderr: 'inherit',
})

for (let tries = 0; ; tries++) {
  const up = await fetch(`http://127.0.0.1:${doorPort}/engined/v1/engines`)
    .then((r) => r.ok)
    .catch(() => false)
  if (up) {
    break
  }
  if (tries > 100) {
    throw new Error('the scratch door never answered')
  }
  await Bun.sleep(100)
}

const svc = startConfigsvc(
  { port: 0 },
  {
    configFile,
    enginesRoot: join(repo, 'engines'),
    bunx: Bun.which('bunx') ?? 'bunx',
    stateRoot: join(root, 'state', 'engined'),
    doorUrl: () => `http://127.0.0.1:${doorPort}`,
    reload: async (signal) => {
      door.kill(signal === 'HUP' ? 'SIGHUP' : 'SIGUSR1')
      return { ok: true }
    },
    secrets: secretTool,
    audit: () => undefined,
    fetch,
    // The smoke stays independent of this host's docker, GPU and agents; a manual preview reports them.
    doctor: process.env.E2E === '1' ? async () => ({ ok: true, checks: [] }) : () => runDoctor(),
  },
)
console.log(`READY ${JSON.stringify({ url: svc.logLine.replace(/^configsvc: /, ''), configFile })}`)

process.on('SIGTERM', () => {
  svc.stop()
  door.kill('SIGTERM')
  // Every run makes a fresh scratch root; without this each smoke and preview leaves one in /var/tmp.
  rmSync(root, { recursive: true, force: true })
  process.exit(0)
})
