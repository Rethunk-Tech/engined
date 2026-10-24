/**
 * `engined --doctor`: one line per host check, each with the fix when it fails.
 * Every probe is an injected function with a real default, so a test drives
 * pass and fail without the host; the same runner can serve the report over
 * HTTP later. Nothing here reads or prints a secret.
 */
import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_IDS, agentCli } from './agents.ts'
import { type ObservedVersion, observeAgentVersion } from './agentVersion.ts'
import { loadConfig } from './config.ts'
import { specFactsFor } from './configRoutes.ts'
import { ambientEnv } from './env.ts'
import { binExec, type ExecResult } from './exec.ts'
import { installDir } from './paths.ts'
import { errMessage } from './records.ts'
import type { Config } from './types.ts'
import { ENGINED_ENGINES_PATH } from './usage.ts'

interface DoctorCheck {
  id: string
  ok: boolean
  detail: string
  /** What to run or change; present only on a failure. */
  fix?: string
  /** Set when the check did not run, with `detail` saying why; a skipped check is not a failure. */
  skipped?: boolean
}

export interface DoctorReport {
  ok: boolean
  checks: DoctorCheck[]
}

export interface DoctorDeps {
  run: (cmd: string, args: readonly string[]) => Promise<ExecResult>
  exists: (path: string) => boolean
  which: (cmd: string) => string | null
  agentVersion: (agent: string) => Promise<ObservedVersion>
  portFree: (port: number) => Promise<boolean>
  /** Whether an engined answers the engines list on `port`. */
  enginedOn: (port: number) => Promise<boolean>
  readable: (path: string) => boolean
  loadConfig: () => Config
  /** Where `engines/<id>/spec.toml` lives, so a disabled agentic engine can be told from one that is absent. */
  enginesRoot: string
}

const DEFAULT_DEPS: DoctorDeps = {
  run: (cmd, args) => binExec(cmd, DOCTOR_TIMEOUT_MS)(args),
  exists: existsSync,
  which: (cmd) => Bun.which(cmd),
  agentVersion: (agent) => observeAgentVersion(agent, 'unpinned'),
  portFree: (port) => {
    try {
      Bun.listen({
        hostname: '127.0.0.1',
        port,
        socket: {
          data() {
            return
          },
        },
      }).stop(true)
      return Promise.resolve(true)
    } catch {
      return Promise.resolve(false)
    }
  },
  enginedOn: async (port) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${ENGINED_ENGINES_PATH}`, {
        signal: AbortSignal.timeout(DOCTOR_TIMEOUT_MS),
      })
      return res.ok && Array.isArray(((await res.json()) as { engines?: unknown }).engines)
    } catch {
      return false
    }
  },
  readable: (path) => {
    try {
      accessSync(path, constants.R_OK)
      return true
    } catch {
      return false
    }
  },
  loadConfig: () => loadConfig(),
  enginesRoot: join(installDir(), 'engines'),
}

const DOCTOR_TIMEOUT_MS = 10_000

const pass = (id: string, detail: string): DoctorCheck => ({ id, ok: true, detail })
const fail = (id: string, detail: string, fix: string): DoctorCheck => ({
  id,
  ok: false,
  detail,
  fix,
})
const skip = (id: string, detail: string): DoctorCheck => ({ id, ok: true, skipped: true, detail })

async function dockerCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const res = await deps.run('docker', ['version', '--format', '{{.Server.Version}}'])
  return res.exitCode === 0
    ? pass('docker', `reachable, server ${res.stdout.trim()}`)
    : fail(
        'docker',
        `docker did not answer: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
        'start the docker service and add this user to the docker group',
      )
}

function deviceChecks(deps: DoctorDeps): DoctorCheck[] {
  return ['/dev/kfd', '/dev/dri'].map((path) =>
    deps.exists(path)
      ? pass(path, 'present')
      : fail(
          path,
          'missing',
          'install the amdgpu driver stack and re-login; GPU engines cannot start without it',
        ),
  )
}

/** Which agents an enabled engine still launches, and which appear only on disabled engines. */
interface AgentUse {
  demanded: Set<string>
  retired: Set<string>
}

/**
 * A spec that cannot be read demands every agent: a missing file must not hide
 * a real failure. An agent no engine names is neither demanded nor retired, so
 * the host check still runs.
 */
function agentUse(deps: DoctorDeps, config: Config): AgentUse {
  const enabled = new Map<string, boolean>()
  for (const engine of config.engines) {
    let agent: string | undefined
    try {
      agent = specFactsFor(engine, deps.enginesRoot).agent
    } catch {
      return { demanded: new Set(AGENT_IDS), retired: new Set() }
    }
    if (agent === undefined) {
      continue
    }
    enabled.set(agent, (enabled.get(agent) ?? false) || engine.disabled !== true)
  }
  const demanded = new Set<string>()
  const retired = new Set<string>()
  for (const [agent, on] of enabled) {
    ;(on ? demanded : retired).add(agent)
  }
  return { demanded, retired }
}

function agentRetired(use: AgentUse | undefined, id: string): boolean {
  if (use === undefined) {
    return false
  }
  return use.retired.has(id) && !use.demanded.has(id)
}

function bwrapCheck(deps: DoctorDeps, use?: AgentUse): DoctorCheck {
  if (agentRetired(use, 'opencode')) {
    return skip('bwrap', 'opencode is disabled')
  }
  const path = deps.which('bwrap')
  return path === null
    ? fail('bwrap', 'not on PATH', 'install bubblewrap (opencode runs only inside its sandbox)')
    : pass('bwrap', path)
}

async function agentChecks(deps: DoctorDeps, use?: AgentUse): Promise<DoctorCheck[]> {
  const bunx = ambientEnv.ENGINED_BUNX || deps.which('bunx')
  const checks: DoctorCheck[] = []
  for (const id of AGENT_IDS) {
    if (agentRetired(use, id)) {
      checks.push(skip(`agent ${id}`, 'its engine is disabled'))
      continue
    }
    const cli = agentCli(id)
    if (cli?.pkg !== undefined) {
      checks.push(
        bunx
          ? pass(
              `agent ${id}`,
              `runs through bunx (${cli.pkg}), version pinned by the engine's agent_version`,
            )
          : fail(`agent ${id}`, 'bunx not found', 'install bun, or set ENGINED_BUNX'),
      )
      continue
    }
    const seen = await deps.agentVersion(id)
    checks.push(
      seen.ok
        ? pass(`agent ${id}`, `binary reports ${seen.version}`)
        : fail(
            `agent ${id}`,
            seen.error ?? 'no version observed',
            'install the agent from its vendor',
          ),
    )
  }
  return checks
}

async function keyringCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  if (deps.which('secret-tool') === null) {
    return fail('keyring', 'secret-tool not on PATH', 'install libsecret-tools')
  }
  // Ownership of the Secret Service name proves the session bus and a keyring daemon answer, without touching an item.
  const bus = await deps.run('busctl', ['--user', 'status', 'org.freedesktop.secrets'])
  return bus.exitCode === 0
    ? pass('keyring', 'secret-tool present and the Secret Service answers on the session bus')
    : fail(
        'keyring',
        'the session bus has no Secret Service',
        'sign in to a desktop session with an unlocked keyring (gnome-keyring or kwallet)',
      )
}

async function portChecks(deps: DoctorDeps, config: Config): Promise<DoctorCheck[]> {
  const running = await deps.enginedOn(config.listen_port)
  const ports: [string, number][] = [
    ['listen_port', config.listen_port],
    ['cursor_port', config.cursor_port],
    ...(config.configsvc.enable
      ? ([['configsvc port', config.configsvc.port]] as [string, number][])
      : []),
  ]
  const checks: DoctorCheck[] = []
  for (const [label, port] of ports) {
    if (await deps.portFree(port)) {
      checks.push(pass(label, `${port} is free`))
    } else if (running) {
      checks.push(pass(label, `${port} is held by the running engined`))
    } else {
      checks.push(
        fail(
          label,
          `${port} is held by another process`,
          `free the port or change ${label.split(' ')[0]} in config.toml`,
        ),
      )
    }
  }
  return checks
}

function modelsDirChecks(deps: DoctorDeps, config: Config): DoctorCheck[] {
  return config.engines
    .filter((engine) => engine.models_dir !== undefined && engine.disabled !== true)
    .map((engine) =>
      deps.readable(engine.models_dir as string)
        ? pass(`models_dir ${engine.id}`, engine.models_dir as string)
        : fail(
            `models_dir ${engine.id}`,
            `${engine.models_dir} is not readable`,
            'create the directory or fix its permissions',
          ),
    )
}

export async function runDoctor(overrides: Partial<DoctorDeps> = {}): Promise<DoctorReport> {
  const deps = { ...DEFAULT_DEPS, ...overrides }
  const checks: DoctorCheck[] = [
    await dockerCheck(deps),
    ...deviceChecks(deps),
    await keyringCheck(deps),
  ]
  try {
    const config = deps.loadConfig()
    const use = agentUse(deps, config)
    checks.push(
      bwrapCheck(deps, use),
      ...(await agentChecks(deps, use)),
      ...(await portChecks(deps, config)),
      ...modelsDirChecks(deps, config),
    )
  } catch (err) {
    checks.push(
      bwrapCheck(deps),
      ...(await agentChecks(deps)),
      skip('config', `ports and models_dir not checked, no valid config: ${errMessage(err)}`),
    )
  }
  return { ok: checks.every((check) => check.ok), checks }
}

export function formatDoctor(report: DoctorReport): string {
  return report.checks
    .map((c) => {
      const mark = checkMark(c)
      return `${mark} ${c.id}: ${c.detail}${c.fix === undefined ? '' : `\n     fix: ${c.fix}`}`
    })
    .join('\n')
}

export async function doctorExit(
  json: boolean,
  write: (line: string) => void,
  overrides: Partial<DoctorDeps> = {},
): Promise<number> {
  const report = await runDoctor(overrides)
  write(json ? JSON.stringify({ schema: 1, ...report }) : formatDoctor(report))
  return report.ok ? 0 : 1
}

function checkMark(c: DoctorCheck): string {
  if (c.skipped) {
    return 'skip'
  }
  return c.ok ? 'ok  ' : 'FAIL'
}
