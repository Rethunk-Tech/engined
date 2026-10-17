import { readFileSync } from 'node:fs'
import {
  DEFAULT_AGENT_TIMEOUT_SECONDS,
  DEFAULT_AGENTIC_CONCURRENCY,
  DEFAULT_CHAT_TIMEOUT_SECONDS,
  DEFAULT_CURSOR_PORT,
  DEFAULT_LISTEN_PORT,
  DEFAULT_STREAM_STALL_SECONDS,
} from './config.ts'
import { parsePort } from './configParse.ts'
import { configPath } from './paths.ts'
import { isRecord } from './records.ts'
import type { Config } from './types.ts'

/** The port to bind while no config is valid: the file's `listen_port` when it parses and is a port, else the default. Never throws. */
export function bestEffortListenPort(path: string = configPath()): number {
  try {
    const raw: unknown = Bun.TOML.parse(readFileSync(path, 'utf8'))
    return parsePort(
      isRecord(raw) ? raw.listen_port : undefined,
      'listen_port',
      path,
      DEFAULT_LISTEN_PORT,
    )
  } catch {
    return DEFAULT_LISTEN_PORT
  }
}

/** A config serving nothing, for a door that is up before any config is valid. */
export function awaitingConfig(listenPort: number): Config {
  return {
    listen_port: listenPort,
    cursor_port: DEFAULT_CURSOR_PORT,
    chat_timeout_seconds: DEFAULT_CHAT_TIMEOUT_SECONDS,
    agent_timeout_seconds: DEFAULT_AGENT_TIMEOUT_SECONDS,
    stream_stall_seconds: DEFAULT_STREAM_STALL_SECONDS,
    agentic_concurrency: DEFAULT_AGENTIC_CONCURRENCY,
    engines: [],
    upstreams: [],
    routes: [],
    chains: {},
  }
}
