/** Validating candidate `config.toml` text the way engined will read it, before anything is written. */
import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from './config.ts'
import { specDigest } from './dockerArgs.ts'
import { buildEntries } from './engineEntries.ts'
import { type ConfigPath, ParseError } from './errors/parse.ts'
import { llamaPresetPath } from './paths.ts'
import { errMessage } from './records.ts'
import { isContainerSpec } from './specTypes.ts'
import type { Config } from './types.ts'

interface Problem {
  message: string
  file?: string
  line?: number
  column?: number
  /** The entry and key at fault, when the parser knew them. */
  path?: ConfigPath
}

export interface Checked {
  config?: Config
  problem?: Problem
}

export interface ValidateEnv {
  /** The live `config.toml`; the candidate is written beside it so `config.d/` resolves. */
  configFile: string
  enginesRoot: string
  bunx: string
}

const LOCATION_RE = /^(.+?):(\d+):(\d+): /

function problemOf(err: unknown, tempFile: string, configFile: string): Problem {
  const message = errMessage(err).replaceAll(tempFile, configFile)
  const located = LOCATION_RE.exec(message)
  return {
    message,
    ...(located === null
      ? {}
      : { file: located[1], line: Number(located[2]), column: Number(located[3]) }),
    ...(err instanceof ParseError && err.path !== undefined
      ? { path: { ...err.path, file: err.path.file.replaceAll(tempFile, configFile) } }
      : {}),
  }
}

/** `loadConfig` on a temp copy, then the checks engined runs once specs load (`buildEntries`). */
export function checkConfigText(text: string, env: ValidateEnv): Checked {
  const temp = join(dirname(env.configFile), `.validate-${randomBytes(6).toString('hex')}.toml`)
  try {
    writeFileSync(temp, text)
    const config = loadConfig(temp, env.enginesRoot)
    buildEntries(config, { enginesRoot: env.enginesRoot, bunx: env.bunx }, llamaPresetPath)
    return { config }
  } catch (err) {
    return { problem: problemOf(err, temp, env.configFile) }
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Engine ids whose container launch (its `specDigest`) differs between two configs; engines present in only one are not restarts. */
export function enginesToRestart(before: Config, after: Config, env: ValidateEnv): string[] {
  const digests = (config: Config): Map<string, string> => {
    const out = new Map<string, string>()
    for (const entry of buildEntries(
      config,
      { enginesRoot: env.enginesRoot, bunx: env.bunx },
      llamaPresetPath,
    )) {
      if (isContainerSpec(entry.spec.spec) && entry.engine.disabled !== true) {
        out.set(entry.engine.id, specDigest(entry.spec.spec))
      }
    }
    return out
  }
  const old = digests(before)
  return [...digests(after)].flatMap(([id, digest]) =>
    old.has(id) && old.get(id) !== digest ? [id] : [],
  )
}
