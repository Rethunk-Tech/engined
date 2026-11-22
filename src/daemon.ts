/** The process half of engined: startup, listeners, and the signal handlers that reload or stop it. */
import { mkdirSync } from 'node:fs'
import process from 'node:process'
import { buildAgenticProbeRunner } from './agenticProbeHarness.ts'
import { loadConfig } from './config.ts'
import { awaitingConfig, bestEffortListenPort } from './configAwaiting.ts'
import { configFilesSha256 } from './configSources.ts'
import { type CursorAgentServer, serveCursorAgent } from './cursorAgent.ts'
import { completeLocally } from './cursorChat.ts'
import type { Door, DoorOptions } from './doorContext.ts'
import { FatalError } from './errors/fatal.ts'
import { bindDoor, errorCode } from './listen.ts'
import { configPath, installDir, voicesDir } from './paths.ts'
import { flushCallSummaries, writeToStdout } from './provenance.ts'
import { errMessage } from './records.ts'
import type { RegistryOptions } from './registryOptions.ts'
import { seedLegacySecrets } from './secrets.ts'
import type { Config } from './types.ts'

export function runDaemon(make: {
  resolveBunx: () => string
  createDoor: (config: Config, registryOpts: RegistryOptions, doorOpts?: DoorOptions) => Door
  /** Tests replace this so the handlers are not registered on the shared process. */
  on?: (event: 'SIGHUP' | 'SIGUSR1' | 'SIGTERM', listener: () => void) => void
}): { hangup: () => void; hardReload: () => Promise<void>; stop: () => Promise<void> } {
  const { resolveBunx, createDoor } = make
  const path = configPath()
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
      const config = loadConfig()
      seedLegacySecrets(config)
      return createDoor(config, registryOpts)
    } catch (err) {
      // A restart cannot fix a bad config, but an edit can: the door comes up
      // answering 503 with the reason, and the next reload signal loads it.
      process.stderr.write(`waiting for a valid config: ${errMessage(err)}\n`)
      return createDoor(awaitingConfig(bestEffortListenPort()), registryOpts, {
        awaitingConfigError: errMessage(err),
        awaitingConfigSha256: configFilesSha256(configPath()),
      })
    }
  }

  function bindOrExit(boundDoor: Door, port: number): ReturnType<typeof bindDoor> {
    try {
      return bindDoor(boundDoor.fetch, port)
    } catch (err) {
      const what = errorCode(err) === 'EADDRINUSE' ? 'already in use' : 'cannot listen'
      process.stderr.write(`engined: port ${port} ${what}: ${errMessage(err)}\n`)
      process.exit(FatalError.EXIT_CODE)
    }
  }

  let door: Door
  try {
    door = buildDoor()
  } catch (err) {
    process.stderr.write(`engined: ${errMessage(err)}\n`)
    process.exit(FatalError.EXIT_CODE)
  }
  let bound = bindOrExit(door, door.served.listen)
  let cursorAgent: CursorAgentServer | undefined
  let started = false

  function startCursor(port: number): void {
    cursorAgent = serveCursorAgent(port, {
      complete: (messages, on) => completeLocally(door.ctx, messages, on),
      allowedHosts: () => door.ctx.getConfig().allowed_hosts,
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

  /**
   * The listeners a rebind has opened but not yet committed. They are bound
   * before `registry.reload` runs -- so a port already taken fails the reload
   * with the old config still serving -- but the old listeners stay up until
   * that reload has actually landed: a reload that throws must leave the door
   * answering on the port it was already serving, not on the new one with the
   * previous config.
   */
  let rebinding: { listen?: ReturnType<typeof bindDoor>; listenPort?: number; cursorPort?: number }

  function rebind(next: Config): void {
    const fresh: typeof rebinding = {}
    if (next.listen_port !== door.served.listen) {
      fresh.listen = bindDoor(door.fetch, next.listen_port)
      fresh.listenPort = next.listen_port
    }
    if (door.served.cursor !== undefined && next.cursor_port !== door.served.cursor) {
      fresh.cursorPort = next.cursor_port
    }
    rebinding = fresh
  }

  /** Moves the listeners a rebind prepared, or closes them again when the reload it was preparing for did not land. */
  function commitRebind(): void {
    const fresh = rebinding
    rebinding = undefined
    if (fresh === undefined) {
      return
    }
    if (door.configError() !== undefined) {
      for (const s of fresh.listen ?? []) {
        s.stop()
      }
      return
    }
    if (fresh.listen !== undefined) {
      for (const s of bound) {
        s.stop()
      }
      bound = fresh.listen
      door.served.listen = fresh.listenPort as number
    }
    if (fresh.cursorPort !== undefined) {
      cursorAgent?.stop()
      door.served.cursor = undefined
      startCursor(fresh.cursorPort)
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
      await door.registry.shutdown()
      door.reload(path, rebind)
      commitRebind()
      afterReload()
    } finally {
      hardReloading = false
    }
  }

  afterReload()

  const hangup = (): void => {
    door.reload(path)
    afterReload()
  }
  const requestHardReload = (): Promise<void> =>
    hardReload().catch((err: unknown) => {
      process.stderr.write(`hard reload failed: ${errMessage(err)}\n`)
    })
  const stop = (): Promise<void> =>
    door.registry
      .shutdown()
      .then(() => {
        flushCallSummaries(door.ctx.doorOpts.write ?? writeToStdout)
        door.ctx.usage.shutdown()
        cursorAgent?.stop()
        for (const s of bound) {
          s.stop()
        }
        process.exit(0)
      })
      .catch((err: unknown) => {
        process.stderr.write(`shutdown failed: ${errMessage(err)}\n`)
        // TEMP-PROVE-REVERT
        // The engine teardown did not finish, so systemd's own timeout is not
        // the one that should kill this process: exit non-zero now, while the
        // operator can still see why in the unit's status.
        process.exit(1)
      })

  const listen = make.on ?? ((event, listener) => process.on(event, listener))
  listen('SIGHUP', hangup)
  listen('SIGUSR1', () => {
    requestHardReload().catch(() => undefined)
  })
  listen('SIGTERM', () => {
    stop().catch(() => undefined)
  })
  return { hangup, hardReload: requestHardReload, stop }
}
