/**
 * The docker invocations the lifecycle issues, each one command and the
 * reading of its answer. None of them holds or changes any runtime state;
 * `DockerLifecycle` decides what their answers mean for an engine.
 */

import { existsSync } from 'node:fs'
import {
  buildRunArgs,
  extraBuildArgs,
  extraBuildContexts,
  hostPathFor,
  mountSpec,
  parseExposedPort,
  parseHostPort,
  SPEC_LABEL,
  specDockerfile,
} from './dockerArgs.ts'
import type { Exec } from './exec.ts'
import { type EngineResources, parseResources, RESOURCE_PROBE_SH } from './resources.ts'
import type { RunnableContainerSpec } from './specTypes.ts'
import type { Artifact } from './types.ts'

/** docker's own "could not start the container" exit code, distinct from the command that ran failing. */
const DOCKER_START_FAILURE_EXIT_CODE = 125
const NO_SUCH_CONTAINER = /no such container/i

export type Result<T = unknown> = ({ ok: true } & T) | { ok: false; fix?: string; error: string }

/**
 * `pull` always has a runnable fix: the image name is the whole command.
 * `build` does not by default -- `docker build <image>` treats the image
 * name as a context PATH and fails. A real fix needs the spec's own
 * directory, which is the build context and where its Dockerfile lives
 * unless `dockerfile-path` names another. `obtain = "build"` with no
 * Dockerfile to be found means the image was built elsewhere and only
 * tagged locally, so naming a path that does not exist would be the same
 * defect in a new costume.
 */
function buildImageFix(spec: RunnableContainerSpec, specSource?: string): string {
  if (spec.obtain === 'pull') {
    return `docker pull ${spec.image}`
  }
  if (specSource !== undefined) {
    const dockerfile = specDockerfile(specSource)
    if (existsSync(dockerfile)) {
      return `docker build -t ${spec.image}${extraBuildContexts(specSource)}${extraBuildArgs(specSource)} -f ${dockerfile} ${specSource}`
    }
  }
  const where = specSource === undefined ? '' : ` at ${specSource}`
  return `${spec.image}: no Dockerfile${where} to build from -- this image must already exist locally, built some other way`
}

export async function checkImage(
  exec: Exec,
  spec: RunnableContainerSpec,
  specSource?: string,
): Promise<Result<{ containerPort: number }>> {
  const res = await exec(['image', 'inspect', spec.image])
  if (res.exitCode !== 0) {
    return {
      ok: false,
      fix: buildImageFix(spec, specSource),
      error: `${spec.image}: image not present`,
    }
  }
  const parsed = parseExposedPort(res.stdout, spec.image)
  if ('error' in parsed) {
    return { ok: false, error: parsed.error }
  }
  return { ok: true, containerPort: parsed.port }
}

function missingArtifact(image: string, artifact: Artifact): Result {
  return {
    ok: false,
    fix: artifact.obtain,
    error: `${image}: artifact missing at ${artifact.path}`,
  }
}

/**
 * A bind-mounted artifact is a plain host `stat` — no container needed.
 * What's left after that (a named volume, or nothing declared to mount it
 * at all) is checked the only way it can be: a short-lived container per
 * artifact, mounting every volume the spec declares.
 */
export async function checkArtifacts(exec: Exec, spec: RunnableContainerSpec): Promise<Result> {
  const needsContainer: Artifact[] = []
  for (const artifact of spec.artifacts) {
    const hostPath = hostPathFor(artifact, spec.volumes)
    if (hostPath === null) {
      needsContainer.push(artifact)
    } else if (!existsSync(hostPath)) {
      return missingArtifact(spec.image, artifact)
    }
  }
  if (needsContainer.length === 0) {
    return { ok: true }
  }
  const volumeArgs = spec.volumes.flatMap((v) => ['-v', mountSpec(v)])
  const checks = await Promise.all(
    needsContainer.map(async (artifact) => ({
      artifact,
      res: await exec([
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        ...volumeArgs,
        spec.image,
        '-c',
        `test -e '${artifact.path}'`,
      ]),
    })),
  )
  for (const { artifact, res } of checks) {
    if (res.exitCode === 0) {
      continue
    }
    if (res.exitCode === DOCKER_START_FAILURE_EXIT_CODE) {
      return {
        ok: false,
        error: `${spec.image}: could not check artifact ${artifact.path} (volume unreachable)`,
      }
    }
    return missingArtifact(spec.image, artifact)
  }
  return { ok: true }
}

/** Running only: a container that already exited holds nothing, and the next start removes it as it always did. */
export async function findOrphan(
  exec: Exec,
  containerName: string,
): Promise<{ digest: string; ports: string } | null> {
  const res = await exec([
    'ps',
    '--filter',
    `name=^${containerName}$`,
    '--format',
    `{{.Names}}\t{{.Label "${SPEC_LABEL}"}}\t{{.Ports}}`,
  ])
  const line = res.stdout.trim()
  if (res.exitCode !== 0 || line === '') {
    return null
  }
  const [, digest, ports] = line.split('\t')
  return { digest: digest ?? '', ports: ports ?? '' }
}

/**
 * A container by this name is never resumed as-is: its creation-time args
 * can predate the spec now in force. `-f` is required, not cosmetic: a
 * still-running container (the exact case a daemon restart leaves behind)
 * refuses a plain `rm`, and the `docker run` that follows then fails 125
 * "name already in use" -- indistinguishable from a genuine startup
 * failure unless something recovers it. "No such container" is the normal
 * case (nothing to remove) and is not an error; anything else means `run`
 * would hit the same conflict, so it is surfaced now instead.
 */
export async function runContainer(
  exec: Exec,
  containerName: string,
  spec: RunnableContainerSpec,
  containerPort: number,
): Promise<Result> {
  const rm = await exec(['rm', '-f', containerName])
  if (rm.exitCode !== 0 && !NO_SUCH_CONTAINER.test(rm.stderr)) {
    return { ok: false, error: rm.stderr.trim() || `docker rm -f failed for ${containerName}` }
  }
  const run = await exec(buildRunArgs(containerName, spec, containerPort))
  if (run.exitCode !== 0) {
    return { ok: false, error: run.stderr.trim() || `docker run failed for ${containerName}` }
  }
  return { ok: true }
}

export async function readHostPort(
  exec: Exec,
  containerName: string,
  containerPort: number,
): Promise<number | null> {
  const res = await exec(['port', containerName, `${containerPort}/tcp`])
  return res.exitCode === 0 ? parseHostPort(res.stdout) : null
}

/**
 * `docker logs --tail`, merged. docker writes the container's stdout to ours
 * and its stderr to ours, so the two arrive already separated and their
 * relative order is lost before this sees them -- most engines log to stderr,
 * so dropping it would return an empty log for a container that is talking.
 */
export async function readLogs(
  exec: Exec,
  containerName: string,
  tail: number,
): Promise<Result<{ lines: string[] }>> {
  const res = await exec(['logs', '--tail', String(tail), containerName])
  if (res.exitCode !== 0) {
    return { ok: false, error: res.stderr.trim() || `docker logs failed for ${containerName}` }
  }
  const merged = `${res.stdout}${res.stderr}`.split('\n')
  // A trailing newline yields one empty element that is not a log line.
  if (merged.at(-1) === '') {
    merged.pop()
  }
  return { ok: true, lines: merged }
}

/** What a running container holds right now, in one `docker exec`. */
export async function readResources(
  exec: Exec,
  containerName: string,
): Promise<Result<{ resources: EngineResources }>> {
  const res = await exec(['exec', containerName, 'sh', '-c', RESOURCE_PROBE_SH])
  if (res.exitCode !== 0) {
    return {
      ok: false,
      error: res.stderr.trim() || `docker exec failed for ${containerName}`,
    }
  }
  return { ok: true, resources: parseResources(res.stdout) }
}
