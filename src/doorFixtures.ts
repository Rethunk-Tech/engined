/** Specs, fakes and door builders shared by the door's test files. */

import { mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgenticProbeRunner } from './agenticProbe.ts'
import type { Probe } from './docker.ts'
import { NAME_PREFIX } from './docker.ts'
import type { DoorOptions } from './doorContext.ts'
import type { Exec, ExecResult } from './exec.ts'
import type { HttpClient } from './http.ts'
import { createDoor, type Door } from './main.ts'
import {
  BUNX,
  buildExec,
  config,
  containerRunning,
  engine,
  inspectSinglePort,
  portResult,
  route,
  tempPresetPath,
  withLlamaControl,
  writeEngineSpec,
} from './test-support.ts'
import type { Config, EngineEntry } from './types.ts'

const LLAMA_FAKE_INSPECT_PORT = 8080

/** A plausible launch-scoped door URL for a `resolveRedirect` unit test that never touches the real door. */
export const TEST_DOOR_URL = 'http://127.0.0.1:29200/openai/v1/deadbeefdeadbeefdeadbeefdeadbeef'

export const PASSING_PROBE: AgenticProbeRunner = () => Promise.resolve({ ok: true })

/** Every door test that posts a chat completion sends the same request shape; only the JSON body differs. */
export function chatRequest(body: unknown): Request {
  return new Request('http://engined/openai/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export const LOCAL_LLAMA_SPEC = `
kind = "openai-http"
upstream = "self"
image = "ghcr.io/example/llama@sha256:aaaa"
obtain = "pull"
serves = ["/openai/v1/chat/completions", "/openai/v1/embeddings"]
command = []

[ready]
path = "/health"
status = 200
`

export const CLAUDE_SPEC = `
kind = "agentic-cli"
upstream = "optional"
agent = "claude"
serves = ["/openai/v1/chat/completions"]
env = ["HOME"]
`

export const OPENCODE_SPEC = `
kind = "agentic-cli"
upstream = "optional"
agent = "opencode"
serves = ["/openai/v1/chat/completions"]
env = ["HOME"]
`

/** Image present with one exposed port, a fresh host port per "port" lookup. */
export function llamaExec(): Exec {
  let port = 41_000
  return (args) => {
    let result: ExecResult = { stdout: '', stderr: '', exitCode: 0 }
    if (args[0] === 'image' && args[1] === 'inspect') {
      result = inspectSinglePort(LLAMA_FAKE_INSPECT_PORT)
    } else if (args[0] === 'port') {
      port += 1
      result = portResult(port)
    } else if (args[0] === 'inspect') {
      result = containerRunning()
    }
    return Promise.resolve(result)
  }
}

export const READY_200: Probe = () => Promise.resolve({ status: 200 })

/** Every llama-routed door test shares this enginesRoot/bunx/probe/preset wiring; only the config, the http client, and the exec fake (a second engine's failover tests supply their own) vary. */
export function createLlamaDoor(
  cfg: Config,
  root: string,
  doorOpts: DoorOptions = {},
  exec: Exec = llamaExec(),
): Door {
  return createDoor(
    cfg,
    { enginesRoot: root, bunx: BUNX, exec, probe: READY_200 },
    { llamaPresetHostPath: tempPresetPath(dirname(root)), ...doorOpts },
  )
}

/** `/models/load` and `/models/unload` answer immediately; every other call is recorded.
 * Real b10354 contract, probed live: `/models/load` accepts with `{success:true}` and
 * readiness is confirmed via `GET /openai/v1/models`'s per-model `status.value` reaching
 * "loaded" -- an already-resident model's 400 "already running" fires before the
 * child is actually able to serve, so it is not the signal `loadAndWait` trusts. */
export function makeLlamaHttpClient(recorded: { body: string }[]): HttpClient {
  return withLlamaControl((_url, init) => {
    if (typeof init?.body === 'string') {
      recorded.push({ body: init.body })
    }
    return Promise.resolve(
      Response.json({ id: 'resp-1', choices: [{ message: { content: 'hi' } }] }),
    )
  })
}

export function fakeExec(value: string | undefined): Exec {
  return (args) => {
    if (args[0] === 'lookup' && value !== undefined) {
      return Promise.resolve({ stdout: value, stderr: '', exitCode: 0 })
    }
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 })
  }
}

export function claudeEngine(): EngineEntry {
  return engine({ id: 'claude', agent_version: '1.2.3' })
}

export function startRequest(model: string): Request {
  return new Request('http://engined/engined/v1/start', {
    method: 'POST',
    body: JSON.stringify({ model }),
  })
}

/** One local llama engine with a single chat route, its spec written under a fresh directory in `testRoot`. */
export function llamaDoorConfig(testRoot: string): { cfg: Config; root: string } {
  const root = mkdtempSync(join(testRoot, 'engined-door-'))
  writeEngineSpec(root, 'local-llama', LOCAL_LLAMA_SPEC)
  const cfg = config({
    engines: [engine({ id: 'local-llama', models_dir: '/data/gguf', models_max: 1 })],
    routes: [route({ engine: 'local-llama', model: 'ornith', filename: 'x.gguf', role: 'chat' })],
  })
  return { cfg, root }
}

const FAILOVER_DEAD_PORT = 46_001
const FAILOVER_LIVE_PORT = 46_002

/** One shared docker fake for two engines, distinguished by the container name docker.ts always passes. Shared by the answering-route-headers and chain-advance suites. */
export function twoEngineExec(): Exec {
  return buildExec({
    portByContainer: {
      [`${NAME_PREFIX}llama-dead`]: FAILOVER_DEAD_PORT,
      [`${NAME_PREFIX}llama-live`]: FAILOVER_LIVE_PORT,
    },
  })
}

/** The "dead" upstream answers with `deadStatus`; the "live" one always succeeds. Each
 * records its own calls. `/models/load` and `/openai/v1/models` mirror the real b10354
 * contract, probed live: accept, then report "loaded" -- the ready signal
 * `loadAndWait` actually polls for. */
export function makeSplitHttpClient(
  deadStatus: number,
  deadCalls: string[],
  liveCalls: string[],
): HttpClient {
  return withLlamaControl((url) => {
    const { port } = new URL(url)
    if (port === String(FAILOVER_DEAD_PORT)) {
      deadCalls.push(url)
      return Promise.resolve(Response.json({ error: 'dead' }, { status: deadStatus }))
    }
    liveCalls.push(url)
    return Promise.resolve(
      Response.json({ id: 'resp-live', choices: [{ message: { content: 'live' } }] }),
    )
  })
}

/** Two llama engines chained as a failover pair, its specs written under a fresh directory in `testRoot`. */
export function twoEngineDoorConfig(testRoot: string): { cfg: Config; root: string } {
  const root = mkdtempSync(join(testRoot, 'engined-door-'))
  for (const id of ['llama-dead', 'llama-live']) {
    writeEngineSpec(root, id, LOCAL_LLAMA_SPEC)
  }
  const cfg = config({
    engines: [
      engine({ id: 'llama-dead', models_dir: '/data/dead', models_max: 1 }),
      engine({ id: 'llama-live', models_dir: '/data/live', models_max: 1 }),
    ],
    routes: [
      route({ engine: 'llama-dead', model: 'dead-model', filename: 'd.gguf', role: 'chat' }),
      route({ engine: 'llama-live', model: 'live-model', filename: 'l.gguf', role: 'chat' }),
    ],
    chains: { 'chain-failover': ['@/llama-dead/dead-model', '@/llama-live/live-model'] },
  })
  return { cfg, root }
}
