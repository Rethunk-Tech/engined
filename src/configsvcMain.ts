/** `main.js --configsvc`: reads `[configsvc]`, binds the config UI, and runs until stopped. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { loadConfig } from './config.ts'
import { bestEffortListenPort } from './configAwaiting.ts'
import { startConfigsvc } from './configsvc.ts'
import type { ConfigsvcDeps } from './configsvcApi.ts'
import { secretTool } from './configsvcSecrets.ts'
import { runDoctor } from './doctor.ts'
import { FatalError } from './errors/fatal.ts'
import { errorCode } from './listen.ts'
import { configPath, installDir, stateDir } from './paths.ts'
import { errMessage, isRecord } from './records.ts'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 29_202

interface Settings {
  host: string
  port: number
  passwordHash?: string
}

/** What `[configsvc]` says when the whole file does not load: the UI must still come up to repair it. */
function rawSettings(configFile: string): Settings {
  try {
    const raw: unknown = Bun.TOML.parse(readFileSync(configFile, 'utf8'))
    const table = isRecord(raw) && isRecord(raw.configsvc) ? raw.configsvc : {}
    const hash = table.password_hash
    return {
      host: typeof table.host === 'string' ? table.host : DEFAULT_HOST,
      port:
        typeof table.port === 'number' && Number.isInteger(table.port) ? table.port : DEFAULT_PORT,
      ...(typeof hash === 'string' && hash.startsWith('$argon2id$') ? { passwordHash: hash } : {}),
    }
  } catch {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT }
  }
}

async function systemctlKill(signal: 'HUP' | 'USR1'): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn(['systemctl', '--user', 'kill', '-s', signal, 'engined.service'], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `exit ${code}` }
}

export async function configsvcMain(write: (line: string) => void): Promise<number> {
  const configFile = configPath()
  let settings: Settings
  try {
    const config = loadConfig(configFile)
    if (!config.configsvc.enable) {
      write('configsvc: not enabled in config.toml ([configsvc] enable = true); exiting')
      return 0
    }
    settings = {
      host: config.configsvc.host,
      port: config.configsvc.port,
      passwordHash: config.configsvc.password_hash,
    }
  } catch (err) {
    process.stderr.write(
      `config does not load, starting anyway so it can be repaired: ${errMessage(err)}\n`,
    )
    settings = rawSettings(configFile)
  }
  const deps: ConfigsvcDeps = {
    configFile,
    enginesRoot: join(installDir(), 'engines'),
    bunx: process.env.ENGINED_BUNX || Bun.which('bunx') || 'bunx',
    stateRoot: stateDir(),
    doorUrl: () => `http://127.0.0.1:${bestEffortListenPort(configFile)}`,
    reload: systemctlKill,
    secrets: secretTool,
    audit: (line) => process.stderr.write(`${line}\n`),
    fetch,
    // This process holds its own port, so the report must not count that as a conflict.
    doctor: () =>
      runDoctor({
        loadConfig: () => {
          const config = loadConfig(configFile)
          return { ...config, configsvc: { ...config.configsvc, enable: false } }
        },
      }),
  }
  // Bun resolves a bundled page's asset paths against the working directory, and the assets sit beside this file.
  process.chdir(import.meta.dir)
  let started: ReturnType<typeof startConfigsvc>
  try {
    started = startConfigsvc(settings, deps)
  } catch (err) {
    const what = errorCode(err) === 'EADDRINUSE' ? 'already in use' : 'cannot listen'
    process.stderr.write(`configsvc port ${settings.port} ${what}: ${errMessage(err)}\n`)
    return FatalError.EXIT_CODE
  }
  write(started.logLine)
  return await new Promise<number>((resolve) => {
    process.on('SIGTERM', () => {
      started.stop()
      resolve(0)
    })
  })
}
