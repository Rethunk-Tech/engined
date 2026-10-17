/** The process half of engined: startup, listeners, and the signal handlers that reload or stop it. */
import { mkdirSync } from 'node:fs'
import process from 'node:process'
import { buildAgenticProbeRunner } from './agenticProbeHarness.ts'
import { loadConfig } from './config.ts'
import { awaitingConfig, bestEffortListenPort } from './configAwaiting.ts'
import { type CursorAgentServer, serveCursorAgent } from './cursorAgent.ts'
import { completeLocally } from './cursorChat.ts'
import { FatalError } from './errors/fatal.ts'
import { bindDualFamily, errorCode } from './listen.ts'
import { createDoor, type Door, resolveBunx } from './main.ts'
import { configPath, installDir, voicesDir } from './paths.ts'
import { errMessage } from './records.ts'
import type { Config } from './types.ts'

function buildDoor(): Door {
  const bunx = resolveBunx()
  // The mount source a chatterbox spec names must exist before any
  // container starts: docker creates a missing bind source itself, owned by
  // root, and the door would then never be able to write an upload into it.
  mkdirSync(voicesDir(), { recursive: true })
  const registryOpts = {
    enginesRoot: `${installDir()}/engines`,
    bunx,
    agenticProbeRunner: buildAgenticProbeRunner(bunx),
  }
  try {
    return createDoor(loadConfig(), registryOpts)
  } catch (err) {
    // A restart cannot fix a bad config, but an edit can: the door comes up
    // answering 503 with the reason, and the next reload signal loads it.
    process.stderr.write(`waiting for a valid config: ${errMessage(err)}\n`)
    return createDoor(awaitingConfig(bestEffortListenPort()), registryOpts, {
      awaitingConfigError: errMessage(err),
    })
  }
}

function bindOrExit(door: Door, port: number): ReturnType<typeof bindDualFamily> {
  try {
    return bindDualFamily(door.fetch, port)
  } catch (err) {
    const what = errorCode(err) === 'EADDRINUSE' ? 'already in use' : 'cannot listen'
    process.stderr.write(`port ${port} ${what}: ${errMessage(err)}\n`)
    process.exit(FatalError.EXIT_CODE)
  }
}

export function runDaemon(): void {
  const path = configPath()
  let door: Door
  try {
    door = buildDoor()
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`)
    process.exit(FatalError.EXIT_CODE)
  }
  let bound = bindOrExit(door, door.served.listen)
  let cursorAgent: CursorAgentServer | undefined
  let started = false

  function startCursor(port: number): void {
    cursorAgent = serveCursorAgent(port, {
      complete: (messages, on) => completeLocally(door.ctx, messages, on),
    })
    door.served.cursor = port
  }

  // Everything that needs a valid config waits for the first one.
  function afterReload(): void {
    if (!door.live()) {
      return
    }
    const config = door.ctx.getConfig()
    if (!started) {
      started = true
      door.registry.startInventoryRefresh()
      startCursor(config.cursor_port)
    }
    door.discovery.start(config)
  }

  function rebind(next: Config): void {
    if (next.listen_port !== door.served.listen) {
      const fresh = bindDualFamily(door.fetch, next.listen_port)
      bound.v4.stop()
      bound.v6?.stop()
      bound = fresh
      door.served.listen = next.listen_port
    }
    if (door.served.cursor !== undefined && next.cursor_port !== door.served.cursor) {
      cursorAgent?.stop()
      door.served.cursor = undefined
      startCursor(next.cursor_port)
    }
  }

  let hardReloading = false
  async function hardReload(): Promise<void> {
    if (hardReloading) {
      return
    }
    hardReloading = true
    try {
      door.interrupt()
      await door.registry.shutdown().catch(() => undefined)
      door.reload(path, rebind)
      afterReload()
    } finally {
      hardReloading = false
    }
  }

  afterReload()

  process.on('SIGHUP', () => {
    door.reload(path)
    afterReload()
  })
  process.on('SIGUSR1', () => {
    hardReload().catch((err: unknown) => {
      process.stderr.write(`hard reload failed: ${errMessage(err)}\n`)
    })
  })
  process.on('SIGTERM', () => {
    door.registry
      .shutdown()
      .catch(() => undefined)
      .finally(() => {
        door.ctx.usage.shutdown()
        cursorAgent?.stop()
        bound.v4.stop()
        bound.v6?.stop()
        process.exit(0)
      })
  })
}
