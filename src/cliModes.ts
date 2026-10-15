/**
 * Read-only CLI modes. Both talk to the door that is already serving and
 * never bind a second one or start an engine.
 */

import process from 'node:process'
import { loadConfig } from './config.ts'
import { FatalError } from './errors/fatal.ts'
import { discardBody } from './http.ts'
import { runProbes } from './probe.ts'
import { writeToStdout } from './provenance.ts'
import { errMessage, parseRecord } from './records.ts'
import { ENGINED_ENGINES_PATH } from './usage.ts'

function configuredPort(): number | undefined {
  try {
    return loadConfig().listen_port
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`)
    return undefined
  }
}

/**
 * `engined --engines --json`: print the body of `GET /engined/v1/engines`.
 * The list has no text form, so the flag check requires `--json`.
 */
export async function enginesExit(): Promise<number> {
  const port = configuredPort()
  if (port === undefined) {
    return FatalError.EXIT_CODE
  }
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${port}${ENGINED_ENGINES_PATH}`)
  } catch (err) {
    process.stderr.write(`the door could not be reached: ${errMessage(err)}\n`)
    return 1
  }
  if (!res.ok) {
    await discardBody(res)
    process.stderr.write(`the door answered http ${res.status} for its own engine list\n`)
    return 1
  }
  const body = await res.text()
  writeToStdout(body.endsWith('\n') ? body.slice(0, -1) : body)
  // A failed reload keeps serving the previous config and exits 0. The JSON
  // body carries `config_error`; stderr is where an operator sees it without
  // parsing that body.
  const configError = servedConfigError(body)
  if (configError !== undefined) {
    process.stderr.write(`${configError}\n`)
  }
  return 0
}

function servedConfigError(body: string): string | undefined {
  const parsed = parseRecord(body)
  if (parsed === null) {
    return undefined
  }
  const error = parsed.config_error
  return typeof error === 'string' && error !== '' ? error : undefined
}

/** `engined --probe`: call the already-serving door; never bind a second one. */
export async function probeExit(json: boolean): Promise<number> {
  const port = configuredPort()
  if (port === undefined) {
    return FatalError.EXIT_CODE
  }
  const report = await runProbes(`http://127.0.0.1:${port}`)
  if (json) {
    writeToStdout(JSON.stringify(report))
  } else {
    for (const line of report.lines) {
      writeToStdout(`${line.ok ? 'ok' : 'FAIL'} ${line.address}: ${line.detail}`)
    }
  }
  return report.ok ? 0 : 1
}
