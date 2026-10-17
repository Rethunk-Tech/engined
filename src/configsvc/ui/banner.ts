/** The saved-vs-running banner: what an operator must know before trusting that a saved edit is live. */

export interface RunningStatus {
  config_sha256?: string
  config_error?: string
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
  if (input.running.config_error !== undefined) {
    return { kind: 'error', text: `engined reports config_error: ${input.running.config_error}` }
  }
  if (input.running.config_sha256 === input.savedSha) {
    return { kind: 'ok', text: 'engined is running the saved config' }
  }
  return input.lastSavedSha === input.savedSha
    ? { kind: 'warn', text: 'saved but not reloaded' }
    : { kind: 'warn', text: 'engined is running an older config' }
}
