/**
 * Direct unit coverage for `dockerCommands.ts`. `docker.test.ts` exercises
 * most of this module already through `DockerLifecycle`, but never calls
 * `readLogs` or `readResources`, and never drives `checkArtifacts` down its
 * "container unreachable" branch -- this fills those three gaps plus the
 * image-fix fallback for a `build`-obtain spec with no spec dir at all.
 */
import { describe, expect, test } from 'bun:test'
import { checkArtifacts, checkImage, readLogs, readResources } from './dockerCommands.ts'
import type { Exec, ExecResult } from './exec.ts'
import type { RunnableContainerSpec } from './specTypes.ts'
import { inspectSinglePort } from './test-support.ts'

const SPEC: RunnableContainerSpec = {
  kind: 'openai-http',
  serves: ['chat'],
  env: [],
  command: [],
  upstream: 'self',
  image: 'redis:alpine',
  obtain: 'pull',
  devices: [],
  group_add: [],
  security_opt: [],
  init: false,
  streaming: false,
  volumes: [],
  artifacts: [],
  ready: { path: '/health', status: 200 },
}

function ok(stdout: string, stderr = ''): ExecResult {
  return { stdout, stderr, exitCode: 0 }
}

function fail(stderr: string, exitCode = 1): ExecResult {
  return { stdout: '', stderr, exitCode }
}

describe('checkImage: the fix a missing image reports', () => {
  test('obtain = "pull" always has a runnable fix, regardless of spec source', async () => {
    const exec: Exec = () => Promise.resolve(fail('no such image'))
    const result = await checkImage(exec, SPEC)
    expect(result).toEqual({
      ok: false,
      fix: 'docker pull redis:alpine',
      error: 'redis:alpine: image not present',
    })
  })

  test('obtain = "build" with no spec source names that the image must exist some other way', async () => {
    const exec: Exec = () => Promise.resolve(fail('no such image'))
    const result = await checkImage(exec, { ...SPEC, obtain: 'build' })
    expect(result).toEqual({
      ok: false,
      fix: 'redis:alpine: no Dockerfile to build from -- this image must already exist locally, built some other way',
      error: 'redis:alpine: image not present',
    })
  })

  test('image present resolves the exposed port', async () => {
    const exec: Exec = () => Promise.resolve(inspectSinglePort(6379))
    expect(await checkImage(exec, SPEC)).toEqual({ ok: true, containerPort: 6379 })
  })
})

describe('checkArtifacts: a volume the container itself cannot reach', () => {
  const DockerStartFailureExitCode = 125
  const specWithArtifact: RunnableContainerSpec = {
    ...SPEC,
    // No volume covers this path, so the check falls through to a one-shot
    // container rather than a host `stat`.
    artifacts: [
      { path: '/models/x.gguf', obtain: 'curl -o /models/x.gguf https://example/x.gguf' },
    ],
  }

  test('docker refusing to start the check container is reported distinctly from the artifact just being absent', async () => {
    const exec: Exec = () =>
      Promise.resolve(fail('OCI runtime create failed', DockerStartFailureExitCode))
    const result = await checkArtifacts(exec, specWithArtifact)
    expect(result).toEqual({
      ok: false,
      error: 'redis:alpine: could not check artifact /models/x.gguf (volume unreachable)',
    })
  })

  test('any other non-zero exit reports the artifact as missing, carrying its own obtain command as the fix', async () => {
    const exec: Exec = () => Promise.resolve(fail('no such file', 1))
    const result = await checkArtifacts(exec, specWithArtifact)
    expect(result).toEqual({
      ok: false,
      fix: specWithArtifact.artifacts[0]?.obtain,
      error: 'redis:alpine: artifact missing at /models/x.gguf',
    })
  })

  test('a present artifact resolves ok', async () => {
    const exec: Exec = () => Promise.resolve(ok(''))
    expect(await checkArtifacts(exec, specWithArtifact)).toEqual({ ok: true })
  })
})

describe('readLogs', () => {
  test('stdout and stderr are merged, and a trailing blank line from the final newline is dropped', async () => {
    const exec: Exec = () => Promise.resolve(ok('out-1\nout-2\n', 'err-1\n'))
    const result = await readLogs(exec, 'engined-x', 200)
    expect(result).toEqual({ ok: true, lines: ['out-1', 'out-2', 'err-1'] })
  })

  test('a failing docker logs surfaces stderr as the error', async () => {
    const exec: Exec = () => Promise.resolve(fail('No such container: engined-x'))
    expect(await readLogs(exec, 'engined-x', 200)).toEqual({
      ok: false,
      error: 'No such container: engined-x',
    })
  })
})

describe('readResources', () => {
  test('a failing docker exec surfaces stderr as the error', async () => {
    const exec: Exec = () => Promise.resolve(fail('container not running'))
    expect(await readResources(exec, 'engined-x')).toEqual({
      ok: false,
      error: 'container not running',
    })
  })

  test('a successful probe with no DRM device reports memory and null graphics', async () => {
    const exec: Exec = () => Promise.resolve(ok('1048576\nno-dri\n'))
    expect(await readResources(exec, 'engined-x')).toEqual({
      ok: true,
      resources: { memory_bytes: 1_048_576, graphics_bytes: null },
    })
  })
})
