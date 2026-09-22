/**
 * What a container spec becomes on the docker command line — mounts, port
 * bindings, build flags and the digest label that decides whether a running
 * container still matches its spec — and what docker's own output says back
 * about the port it published.
 *
 * Pure: takes strings and specs, touches no process and no socket.
 */

import { existsSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import process from 'node:process'
import type { RunnableContainerSpec } from './specTypes.ts'
import { type Artifact, isRecord, type Volume } from './types.ts'

const HOST_PORT_LINE = /^(?<addr>\d{1,3}(?:\.\d{1,3}){3}):(?<port>\d+)$/

/**
 * Carries `specDigest` on every container engined starts, so a container
 * found running after an unclean exit can say what it was launched from.
 */
export const SPEC_LABEL = 'engined.spec'

type PortResult = { port: number } | { error: string }

export function mountSpec(volume: Volume): string {
  const base = `${volume.name}:${volume.path}`
  return volume.read_only === true ? `${base}:ro` : base
}

/**
 * The host path an artifact lives at, when it sits under a bind-mounted
 * volume (`volume.name` is an absolute host path, not a docker volume name).
 * Null when no volume covers it — a named volume, whose contents only a
 * container can see, or an artifact baked into the image with no mount at all.
 */
export function hostPathFor(artifact: Artifact, volumes: readonly Volume[]): string | null {
  for (const volume of volumes) {
    if (!volume.name.startsWith('/')) {
      continue
    }
    if (artifact.path === volume.path) {
      return volume.name
    }
    const prefix = volume.path.endsWith('/') ? volume.path : `${volume.path}/`
    if (artifact.path.startsWith(prefix)) {
      return posix.join(volume.name, artifact.path.slice(volume.path.length))
    }
  }
  return null
}

/** The container side comes from the image: exposing zero or several ports leaves no field to disambiguate with. */
export function parseExposedPort(inspectJson: string, image: string): PortResult {
  // Docker's keys are PascalCase; reading them off a checked record keeps that casing out of our types.
  const parsed: unknown = JSON.parse(inspectJson)
  const first = Array.isArray(parsed) ? parsed[0] : undefined
  const config = isRecord(first) ? first.Config : undefined
  const exposed = isRecord(config) ? config.ExposedPorts : undefined
  const ports = isRecord(exposed) ? Object.keys(exposed) : []
  if (ports.length === 0) {
    return { error: `${image} exposes no ports` }
  }
  if (ports.length > 1) {
    return { error: `${image} exposes multiple ports: ${ports.join(', ')}` }
  }
  const [port] = ports
  if (port === undefined) {
    return { error: `${image} exposes no ports` }
  }
  const portStr = port.split('/')[0] ?? port
  return { port: Number(portStr) }
}

/**
 * `docker port <container> <port>/tcp` prints one `address:port` line per
 * bound interface — an IPv6 wildcard binding prints as a bracketed `[::]`
 * line beside the IPv4 one. Loopback-only publishing never emits it, but the
 * parser skips rather than accidentally matching it.
 */
export function parseHostPort(portOutput: string): number | null {
  for (const line of portOutput.trim().split('\n')) {
    const port = line.trim().match(HOST_PORT_LINE)?.groups?.port
    if (port !== undefined) {
      return Number(port)
    }
  }
  return null
}

/**
 * `docker ps --format {{.Ports}}` prints one comma-separated mapping per
 * published binding: `127.0.0.1:33103->8006/tcp, [::]:33103->8006/tcp`. The
 * left of each arrow is the host side, which is the shape `parseHostPort`
 * already reads — including the `[::]` line it declines to match.
 */
export function hostBindings(ports: string): string {
  return ports
    .split(',')
    .map((mapping) => mapping.split('->')[0]?.trim() ?? '')
    .join('\n')
}

/** Everything `docker run` takes that comes from the spec, in the order the image needs: flags, then the image, then its argv. */
export function specRunArgs(spec: RunnableContainerSpec): string[] {
  const args: string[] = []
  for (const device of spec.devices) {
    args.push('--device', device)
  }
  for (const group of spec.group_add) {
    args.push('--group-add', group)
  }
  for (const opt of spec.security_opt) {
    args.push('--security-opt', opt)
  }
  if (spec.init) {
    args.push('--init')
  }
  for (const envName of spec.env) {
    const value = process.env[envName]
    if (value !== undefined) {
      args.push('-e', `${envName}=${value}`)
    }
  }
  for (const volume of spec.volumes) {
    args.push('-v', mountSpec(volume))
  }
  const [entryBin, ...entryRest] = spec.entrypoint ?? []
  if (entryBin !== undefined) {
    args.push('--entrypoint', entryBin)
  }
  args.push(spec.image, ...entryRest, ...spec.command)
  return args
}

/**
 * What a container was launched from, condensed to one label value. Derived
 * from the argv itself rather than from a hand-picked list of spec fields, so
 * a field added to `specRunArgs` later is part of the identity without this
 * having to be told about it. The name and the port publish are excluded:
 * both are read back rather than written, and neither says anything about
 * the configuration the container is serving.
 */
export function specDigest(spec: RunnableContainerSpec): string {
  return Bun.SHA256.hash(JSON.stringify(specRunArgs(spec)), 'hex')
}

/**
 * One flag per `name=value` line of `<specSource>/<file>`, appended to the
 * spec's own `docker build`. A spec declares what its Dockerfile needs in the
 * spec dir; nothing here knows which engine is asking or what the names mean.
 * `value` maps the right-hand side where it is not taken literally.
 */
export function declaredBuildFlags(
  specSource: string,
  file: string,
  flag: string,
  value: (raw: string) => string = (raw) => raw,
): string {
  const path = posix.join(specSource, file)
  if (!existsSync(path)) {
    return ''
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => {
      const eq = line.indexOf('=')
      return ` ${flag} ${line.slice(0, eq).trim()}=${value(line.slice(eq + 1).trim())}`
    })
    .join('')
}

/**
 * The `--build-context` flags a spec's Dockerfile needs, one `name=path` per
 * line in `<specSource>/build-contexts`, each path relative to the spec dir.
 *
 * A build's context is the spec's own directory, so a file two images share
 * is in neither of their contexts, and rooting the context higher would pull
 * every other engine's files into both images. A named context is the third
 * option: the shared directory reaches the build under its own name, each
 * image still builds from its own context, and neither build reads anything
 * of the other's.
 */
export function extraBuildContexts(specSource: string): string {
  return declaredBuildFlags(specSource, 'build-contexts', '--build-context', (raw) =>
    posix.resolve(specSource, raw),
  )
}

/**
 * The Dockerfile a spec builds from: its own, or the path named in
 * `<specSource>/dockerfile-path` (relative to the spec dir) when several
 * specs build one recipe into distinct images. `-f` is read from the
 * filesystem, not from the context, so the context stays the spec dir and the
 * shared file's neighbours reach neither build.
 */
export function specDockerfile(specSource: string): string {
  const pointer = posix.join(specSource, 'dockerfile-path')
  if (existsSync(pointer)) {
    return posix.resolve(specSource, readFileSync(pointer, 'utf8').trim())
  }
  return posix.join(specSource, 'Dockerfile')
}

/**
 * The `--build-arg` flags a spec's Dockerfile needs, one `name=value` per
 * line in `<specSource>/build-args`.
 *
 * Two images built from one Dockerfile differ only in what they pass here, so
 * each stays a separate tag from a separate `docker build` and neither
 * build's failure can hold up the other's.
 */
export function extraBuildArgs(specSource: string): string {
  return declaredBuildFlags(specSource, 'build-args', '--build-arg')
}

/** The flags docker never receives from config: the container name and both ports are read back, not written. */
export function buildRunArgs(
  containerName: string,
  spec: RunnableContainerSpec,
  containerPort: number,
): string[] {
  return [
    'run',
    '-d',
    '--name',
    containerName,
    '-p',
    `127.0.0.1::${containerPort}`,
    '--label',
    `${SPEC_LABEL}=${specDigest(spec)}`,
    ...specRunArgs(spec),
  ]
}
