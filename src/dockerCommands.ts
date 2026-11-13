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
  networkCreateArgs,
  networkName,
  parseExposedPort,
  parseHostPort,
  proxyName,
  proxyRunArgs,
  SPEC_LABEL,
  specDigest,
  specDockerfile,
} from './dockerArgs.ts'
import { EXIT_TIMED_OUT, type Exec } from './exec.ts'
import { type EngineResources, parseResources, RESOURCE_PROBE_SH } from './resources.ts'
import type { RunnableContainerSpec } from './specTypes.ts'
import { ARTIFACT_MISSING, type Artifact } from './types.ts'

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
    error: `${image}: ${ARTIFACT_MISSING} ${artifact.path}`,
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

/**
 * Running only: a container that already exited holds nothing, and the next
 * start removes it as it always did. `ports` is what the engine's proxy
 * publishes, and null when no proxy launched with the same digest is running
 * beside it: an engine with no proxy is unreachable however healthy it is.
 */
export async function findOrphan(
  exec: Exec,
  containerName: string,
): Promise<{ digest: string; ports: string | null } | null> {
  const proxy = proxyName(containerName)
  const exact = (name: string): string => `name=^${name.replaceAll('.', '\\.')}$`
  const res = await exec([
    'ps',
    '--filter',
    exact(containerName),
    '--filter',
    exact(proxy),
    '--format',
    `{{.Names}}\t{{.Label "${SPEC_LABEL}"}}\t{{.Ports}}`,
  ])
  if (res.exitCode !== 0) {
    return null
  }
  const rows = new Map(
    res.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [name = '', digest = '', ports = ''] = line.split('\t')
        return [name, { digest, ports }] as const
      }),
  )
  const engine = rows.get(containerName)
  if (engine === undefined) {
    return null
  }
  const paired = rows.get(proxy)
  return { digest: engine.digest, ports: paired?.digest === engine.digest ? paired.ports : null }
}

/**
 * Both containers and the network, so nothing of an earlier pair survives:
 * a container by this name is never resumed as-is, since its creation-time
 * args can predate the spec now in force. `-f` is required, not cosmetic: a
 * still-running container (the exact case a daemon restart leaves behind)
 * refuses a plain `rm`, and the `docker run` that follows then fails 125
 * "name already in use". "No such container" is the normal case (nothing to
 * remove) and is not an error; anything else means `run` would hit the same
 * conflict, so it is surfaced now instead.
 */
export async function removePair(exec: Exec, containerName: string): Promise<Result> {
  const rm = await exec(['rm', '-f', containerName, proxyName(containerName)])
  const conflict = rm.stderr
    .split('\n')
    .filter((line) => line.trim() !== '' && !NO_SUCH_CONTAINER.test(line))
  if (rm.exitCode !== 0 && conflict.length > 0) {
    return { ok: false, error: conflict.join('\n') }
  }
  const net = await exec(['network', 'rm', '-f', networkName(containerName)])
  if (net.exitCode !== 0) {
    return {
      ok: false,
      error: net.stderr.trim() || `docker network rm failed for ${containerName}`,
    }
  }
  return { ok: true }
}

/**
 * The proxy and the network, leaving the engine container: a stopped one
 * keeps its logs readable, and the next start removes it. Best effort,
 * since whatever survives is removed by that same start.
 */
export async function removeProxy(exec: Exec, containerName: string): Promise<void> {
  await exec(['rm', '-f', proxyName(containerName)])
  await exec(['network', 'rm', '-f', networkName(containerName)])
}

/**
 * Whether both halves are up; null when docker did not answer, since reading
 * a timeout as `stopped` would let a start kill a live container.
 */
export async function pairRunning(exec: Exec, containerName: string): Promise<boolean | null> {
  const res = await exec([
    'inspect',
    '-f',
    '{{.State.Running}}',
    containerName,
    proxyName(containerName),
  ])
  if (res.exitCode === EXIT_TIMED_OUT) {
    return null
  }
  return (
    res.exitCode === 0 &&
    res.stdout
      .trim()
      .split('\n')
      .every((line) => line.trim() === 'true')
  )
}

/**
 * Either half dying takes the engine down: with no proxy it is unreachable
 * while still holding its GPU, and a lone proxy serves nothing.
 */
export async function stopPair(exec: Exec, containerName: string): Promise<void> {
  await exec(['stop', containerName])
  await removeProxy(exec, containerName)
}

/** The engine on its own isolated network, then the proxy that publishes its port and joins that network. */
export async function runContainer(
  exec: Exec,
  containerName: string,
  spec: RunnableContainerSpec,
  containerPort: number,
): Promise<Result> {
  const removed = await removePair(exec, containerName)
  if (!removed.ok) {
    return removed
  }
  const steps = [
    networkCreateArgs(containerName),
    buildRunArgs(containerName, spec),
    proxyRunArgs(containerName, containerPort, specDigest(spec)),
    ['network', 'connect', networkName(containerName), proxyName(containerName)],
  ]
  for (const argv of steps) {
    // Sequential by nature: each step needs the one before it to exist.
    const res = await exec(argv)
    if (res.exitCode !== 0) {
      return {
        ok: false,
        error: res.stderr.trim() || `docker ${argv[0]} ${argv[1]} failed for ${containerName}`,
      }
    }
  }
  return { ok: true }
}

/** Read off the proxy, which holds the publish and listens on the engine's own container port. */
export async function readHostPort(
  exec: Exec,
  containerName: string,
  containerPort: number,
): Promise<number | null> {
  const res = await exec(['port', proxyName(containerName), `${containerPort}/tcp`])
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
