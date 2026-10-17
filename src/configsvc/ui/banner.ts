/** The saved-vs-running banner: what an operator must know before trusting that a saved edit is live. */

export interface RunningStatus {
  config_sha256?: string
  config_error?: string
  /** The hash of the files the failed load read; absent when they could not be read at all. */
  config_error_sha256?: string
}

/**
 * The daemon's fault, when it is about the files on disk now. A fault about
 * files since replaced, such as the "cannot read config" of a first run before
 * any save, says nothing about the saved config until the next reload.
 */
export function faultFor(running: RunningStatus, savedSha: string): string | undefined {
  return running.config_error_sha256 === savedSha ? running.config_error : undefined
}

export interface Banner {
  kind: 'ok' | 'warn' | 'error'
  text: string
}

export interface BannerInput {
  /** Hash of the config on disk (`GET /api/config`). */
  savedSha: string
  /** What engined reports; undefined when it could not be reached. */
  running: RunningStatus | undefined
  unreachable?: string
  /** The hash this browser session last saved, to tell "I saved and did not reload" from "someone else changed it". */
  lastSavedSha?: string
}

export function banner(input: BannerInput): Banner {
  if (input.running === undefined) {
    return { kind: 'error', text: `engined is not reachable: ${input.unreachable ?? 'no answer'}` }
  }
  const fault = faultFor(input.running, input.savedSha)
  if (fault !== undefined) {
    return { kind: 'error', text: `engined reports config_error: ${fault}` }
  }
  if (input.savedSha === '') {
    return { kind: 'warn', text: 'no config.toml yet: engined serves nothing until one is saved' }
  }
  if (input.running.config_sha256 === input.savedSha) {
    return { kind: 'ok', text: 'engined is running the saved config' }
  }
  if (input.lastSavedSha === input.savedSha) {
    return { kind: 'warn', text: 'saved but not reloaded' }
  }
  return input.running.config_error === undefined
    ? { kind: 'warn', text: 'engined is running an older config' }
    : { kind: 'warn', text: 'engined has not loaded this config: reload to load it' }
}
