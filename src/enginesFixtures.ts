/** Engine specs, fake execs and registry builders shared by the registry's test files. */

import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { EngineRegistry } from './engines.ts'
import type { Exec, ExecResult } from './exec.ts'
import type { RegistryOptions } from './registryOptions.ts'
import {
  BUNX,
  config,
  engine,
  inspectSinglePort,
  makeTestRoot,
  writeEngineSpec,
} from './test-support.ts'
import type { Config, EngineEntry } from './types.ts'

let testRoot: string | undefined

/**
 * Called once at the top of each test file that uses these fixtures: the
 * directory `newEnginesRoot` and `redirectStateHome` work under, removed
 * once that file's tests finish. Per file, because a root shared across
 * files is gone by the time the second file runs.
 */
export function initTestRoot(prefix: string): void {
  testRoot = makeTestRoot(prefix)
}

function testRootDir(): string {
  if (testRoot === undefined) {
    throw new Error('call initTestRoot at the top of the test file first')
  }
  return testRoot
}

/**
 * Redirects `stateDir()` under the file's test root for whatever the caller does next,
 * returning a restore function for its `finally`. Needed wherever the code
 * under test resolves a path via `stateDir()` (paths.ts) directly rather than
 * through an injectable option -- `llama`'s preset path is one such
 * case, and writes there land on the real operator's state directory
 * otherwise, not a sandbox.
 */
export function redirectStateHome(root?: string): () => void {
  const stateHome = mkdtempSync(join(root ?? testRootDir(), 'engined-state-'))
  const previous = Bun.env.XDG_STATE_HOME
  Bun.env.XDG_STATE_HOME = stateHome
  return () => {
    if (previous === undefined) {
      delete Bun.env.XDG_STATE_HOME
    } else {
      Bun.env.XDG_STATE_HOME = previous
    }
  }
}

export function newEnginesRoot(): string {
  return mkdtempSync(join(testRootDir(), 'engined-engines-'))
}

export const PULLED_CONTAINER = `
kind = "openai-http"
upstream = "self"
image = "ghcr.io/example/llama@sha256:aaaa"
obtain = "pull"
serves = ["/openai/v1/chat/completions"]
command = ["--model", "x"]

[ready]
path = "/health"
status = 200
`

const BUILT_CONTAINER = `
kind = "tts"
upstream = "self"
image = "engined/kokoro:local"
obtain = "build"
serves = ["/openai/v1/audio/speech"]
command = ["--serve"]

[ready]
path = "/health"
status = 200

[[artifact]]
path = "/models/kokoro.bin"
obtain = "docker run --rm -v engined-kokoro-models:/models curlimages/curl -fL -o /models/kokoro.bin https://example.com/kokoro.bin"
`

export const AGENTIC = `
kind = "agentic-cli"
upstream = "optional"
agent = "claude"
serves = ["/openai/v1/chat/completions"]
`

/** Mirrors engines/chatterbox-multi and engines/kokoro's real shape: the image's own CMD is already correct, so command is deliberately empty. */
export const TTS_EMPTY_COMMAND = `
kind = "tts"
upstream = "self"
image = "engined/faketts:local"
obtain = "build"
serves = ["/openai/v1/audio/speech"]
command = []

[ready]
path = "/health"
status = 200
`

/**
 * The one artifact shape no host `stat` can answer: a docker-managed named
 * volume (`name` is not an absolute path), so the check is a container of its
 * own -- a second `docker run` alongside the detached start.
 */
export const STT_VOLUME_ARTIFACT = `
kind = "stt"
upstream = "self"
image = "engined/fakestt:local"
obtain = "build"
serves = ["/openai/v1/audio/transcriptions"]
command = ["--host", "0.0.0.0"]

[ready]
path = "/health"
status = 200

[[volume]]
name = "engined-fakestt-models"
path = "/models"

[[artifact]]
path = "/models/fake.bin"
obtain = "curl -fL -o /models/fake.bin https://example.com/fake.bin"
`

/** Mirrors engines/whisper's real shape: a real command that flags can extend. */
export const STT_REAL_COMMAND = `
kind = "stt"
upstream = "self"
image = "engined/fakestt:local"
obtain = "build"
serves = ["/openai/v1/audio/transcriptions"]
command = ["--host", "0.0.0.0"]

[ready]
path = "/health"
status = 200
`

/** Image present with one exposed port, no artifacts to fail: the tests that only need a registry to exist. */
function okExec(args: readonly string[]): Promise<ExecResult> {
  const result: ExecResult =
    args[0] === 'image' && args[1] === 'inspect'
      ? inspectSinglePort(8000)
      : { stdout: '', stderr: '', exitCode: 0 }
  return Promise.resolve(result)
}

/** `docker image inspect` fails for everything, as it does with nothing pulled. */
export function noImageExec(args: readonly string[]): Promise<ExecResult> {
  const result: ExecResult =
    args[0] === 'image' && args[1] === 'inspect'
      ? { stdout: '', stderr: 'no such image', exitCode: 1 }
      : { stdout: '', stderr: '', exitCode: 0 }
  return Promise.resolve(result)
}

/** Image present, port exposed, but the one declared artifact is missing. */
function missingArtifactExec(args: readonly string[]): Promise<ExecResult> {
  let result: ExecResult = { stdout: '', stderr: '', exitCode: 0 }
  if (args[0] === 'image' && args[1] === 'inspect') {
    result = inspectSinglePort(8000)
  } else if (args[0] === 'run') {
    result = { stdout: '', stderr: '', exitCode: 1 }
  }
  return Promise.resolve(result)
}

export const OK_EXEC: Exec = okExec
export const MISSING_ARTIFACT_EXEC: Exec = missingArtifactExec

export function registry(
  cfg: Config,
  enginesRoot: string,
  extra: Partial<RegistryOptions> = {},
): EngineRegistry {
  return new EngineRegistry(cfg, { enginesRoot, bunx: BUNX, exec: OK_EXEC, ...extra })
}

/** A registry over one "llama" engine backed by a real spec on disk, per the digest-pinned container fixture. */
export function setupLlama(extra: Partial<RegistryOptions> = {}): {
  root: string
  reg: EngineRegistry
} {
  const root = newEnginesRoot()
  writeEngineSpec(root, 'llama', PULLED_CONTAINER)
  return { root, reg: registry(config({ engines: [engine({ id: 'llama' })] }), root, extra) }
}

/** A registry over one "kokoro" engine backed by a real build-obtained spec on disk. */
export function setupKokoro(exec: Exec): { root: string; reg: EngineRegistry } {
  const root = newEnginesRoot()
  writeEngineSpec(root, 'kokoro', BUILT_CONTAINER)
  return { root, reg: registry(config({ engines: [engine({ id: 'kokoro' })] }), root, { exec }) }
}

/** A spec-less engine (declares `kind` in config) with no upstream secret gate any more -- that lives on the upstream table now, not wired into status reporting this phase. */
export function specLessProxyEngine(id: string): EngineEntry {
  return engine({ id, kind: 'stt' })
}
