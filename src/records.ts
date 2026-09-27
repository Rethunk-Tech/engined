/** A TOML table, as distinct from an array or a scalar. Arrays are objects too, which is the trap. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parses JSON text to a table, or `null` for anything unparseable or not a table -- neither counts as one. */
export function parseRecord(text: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return isRecord(parsed) ? parsed : null
}

/** Whatever a `catch` produced, as a string — an `Error`'s message, anything else stringified. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const MS_PER_SECOND = 1000

/**
 * Every "wait for the engine to become able to serve" loop: check, then give
 * up only if the deadline has already passed, then sleep. `true` means the
 * check passed, `false` that the deadline did -- what to do about a `false`
 * differs at each call site, so it is the caller's to decide.
 *
 * The check runs before the deadline is ever consulted, so a deadline of
 * `Date.now()` is one probe rather than none. An `AbortSignal` that is already
 * aborted, or that aborts between probes, is `false` the same as a deadline —
 * the caller distinguishes the two, because what to do about a hang-up is not
 * what to do about time running out.
 */
export async function pollUntil(
  check: () => Promise<boolean>,
  deadline: number,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  for (;;) {
    if (signal?.aborted === true) {
      return false
    }
    if (await check()) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await Bun.sleep(intervalMs)
  }
}
