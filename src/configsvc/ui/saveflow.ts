/** The decisions around saving and reloading: what to default, when a reload counts as applied, which entry to revert to. */
import type { RunningStatus } from './banner.ts'
import type { Doc } from './model.ts'

const APPLY_WAIT_MS = 10_000
const APPLY_POLL_MS = 500

/** A save from the UI keeps the UI enabled unless the operator turned it off on the Settings view. */
export function needsEnableDefault(doc: Doc): boolean {
  const svc = doc.top.configsvc
  return !(typeof svc === 'object' && svc !== null && 'enable' in svc)
}

export type Verdict = { ok: true } | { ok: false; problem: string }

/** Whether the daemon took the saved config: it runs those exact files, reports no fault, and a chosen route test passed. */
export function verdict(input: {
  savedSha: string
  running: RunningStatus | undefined
  routeTest?: { status: number; error?: string }
}): Verdict {
  const { running, savedSha, routeTest } = input
  if (running === undefined) {
    return { ok: false, problem: 'engined did not answer after the reload' }
  }
  if (running.config_error !== undefined) {
    return { ok: false, problem: `engined reports config_error: ${running.config_error}` }
  }
  if (running.config_sha256 !== savedSha) {
    return { ok: false, problem: 'engined is still running an older config' }
  }
  if (routeTest !== undefined && (routeTest.status < 200 || routeTest.status >= 300)) {
    return {
      ok: false,
      problem: `the route test failed (${routeTest.status === 0 ? 'unreachable' : routeTest.status})${routeTest.error === undefined ? '' : `: ${routeTest.error}`}`,
    }
  }
  return { ok: true }
}

/** Polls `read` until the daemon reports the saved hash or a fault, or the wait runs out; returns the last reading. */
export async function waitForApply(
  read: () => Promise<RunningStatus | undefined>,
  savedSha: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  budgetMs = APPLY_WAIT_MS,
): Promise<RunningStatus | undefined> {
  let last: RunningStatus | undefined
  for (let waited = 0; waited <= budgetMs; waited += APPLY_POLL_MS) {
    last = await read()
    if (last?.config_error !== undefined || last?.config_sha256 === savedSha) {
      return last
    }
    await sleep(APPLY_POLL_MS)
  }
  return last
}

/** A save keeps the previous file as the newest history entry; that is what a revert restores. */
export function revertTarget(history: readonly { name: string }[]): string | undefined {
  return history[0]?.name
}
