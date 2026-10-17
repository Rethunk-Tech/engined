import type { Config } from './types.ts'

/** The ports actually bound, which a hot reload compares against; `cursor` is unset until that listener starts. */
export interface ServedPorts {
  listen: number
  cursor?: number
}

const HARD_RELOAD_HINT = 'systemctl --user kill -s USR1 engined.service'

/** A hot reload cannot move a bound listener; naming the signal that can is the fix the error offers. */
export function refuseMovedPorts(served: ServedPorts, next: Config): void {
  const moved: string[] = []
  if (next.listen_port !== served.listen) {
    moved.push(`listen_port ${served.listen} -> ${next.listen_port}`)
  }
  if (served.cursor !== undefined && next.cursor_port !== served.cursor) {
    moved.push(`cursor_port ${served.cursor} -> ${next.cursor_port}`)
  }
  if (moved.length > 0) {
    throw new Error(
      `config changed ${moved.join(', ')}; still serving the old ports. A port change needs a hard reload (stops running engines): ${HARD_RELOAD_HINT}`,
    )
  }
}
