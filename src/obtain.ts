/**
 * `POST /engined/v1/engines/:id/obtain`: runs the spec's `[[artifact]]` obtain
 * commands that are not satisfied yet, streaming their output as SSE. The
 * commands are the spec's own (trusted code, placeholders already resolved);
 * a caller supplies none of it.
 */
import { existsSync } from 'node:fs'
import { hostPathFor } from './dockerArgs.ts'
import type { DoorContext } from './doorContext.ts'
import { jsonError, STATUS_CONFLICT, STATUS_NOT_FOUND } from './http.ts'
import { isContainerSpec } from './specTypes.ts'
import type { Artifact } from './types.ts'

const SSE_CONTENT_TYPE = 'text/event-stream'

/** Runs one shell command, reporting each output line; resolves with its exit code. Killed when `signal` aborts. */
export type ObtainRunner = (
  command: string,
  onLine: (stream: 'stdout' | 'stderr', line: string) => void,
  signal: AbortSignal,
) => Promise<number>

async function pump(
  readable: ReadableStream<Uint8Array>,
  emit: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of readable) {
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      emit(line)
    }
  }
  if (pending !== '') {
    emit(pending)
  }
}

const shellRunner: ObtainRunner = async (command, onLine, signal) => {
  const proc = Bun.spawn(['sh', '-c', command], { stdout: 'pipe', stderr: 'pipe', signal })
  await Promise.all([
    pump(proc.stdout, (line) => onLine('stdout', line)),
    pump(proc.stderr, (line) => onLine('stderr', line)),
  ])
  return await proc.exited
}

const running = new WeakMap<DoorContext, Set<string>>()

/** What is still missing: an artifact with no host path to stat (a named volume) cannot be proven present, so it runs. */
function missing(
  artifacts: readonly Artifact[],
  volumes: Parameters<typeof hostPathFor>[1],
): Artifact[] {
  return artifacts.filter((artifact) => {
    const host = hostPathFor(artifact, volumes)
    return host === null || !existsSync(host)
  })
}

export function handleObtain(
  ctx: DoorContext,
  req: Request,
  engineId: string,
  runner: ObtainRunner = shellRunner,
): Response {
  const spec = ctx.registry.specFor(engineId)
  if (spec === undefined) {
    return jsonError(STATUS_NOT_FOUND, `unknown engine "${engineId}"`)
  }
  if (!isContainerSpec(spec) || spec.artifacts.length === 0) {
    return jsonError(STATUS_NOT_FOUND, `engine "${engineId}" declares no obtain`)
  }
  const held = running.get(ctx) ?? new Set<string>()
  running.set(ctx, held)
  if (held.has(engineId)) {
    return jsonError(STATUS_CONFLICT, `an obtain is already running for engine "${engineId}"`)
  }
  held.add(engineId)
  const todo = missing(spec.artifacts, spec.volumes)

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          // The client went away; the abort signal is already killing the command.
        }
      }
      let exitCode = 0
      try {
        for (const [step, artifact] of todo.entries()) {
          send('step', { step, command: artifact.obtain })
          exitCode = await runner(
            artifact.obtain,
            (source, line) => send('line', { step, stream: source, line }),
            req.signal,
          )
          if (exitCode !== 0) {
            break
          }
        }
      } catch {
        exitCode = 1
      } finally {
        held.delete(engineId)
      }
      send('exit', { exitCode, steps: todo.length })
      try {
        controller.close()
      } catch {
        // Closed by the client's disconnect.
      }
    },
  })
  return new Response(stream, {
    headers: { 'content-type': SSE_CONTENT_TYPE, 'cache-control': 'no-cache' },
  })
}
