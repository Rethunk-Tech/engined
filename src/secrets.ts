/**
 * Resolves a `SecretRef` against the desktop keyring at request time. Never
 * cached across requests: a `--user` unit boots before the login keyring is
 * unlocked by PAM, so a cached failure would need a reload to clear once the
 * operator signs in. Always `secret-tool lookup`, never `search` — `search`
 * printed a live key to stdout during this design.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { binExec, type Exec } from './exec.ts'
import { stateDir, writeFileAtomic } from './paths.ts'
import { errMessage } from './records.ts'
import type { SecretRef } from './types.ts'

type SecretOutcome =
  | { ok: true; value: string }
  | { ok: false; reason: 'missing'; fix: string }
  | { ok: false; reason: 'locked'; fix: string }

const secretExec: Exec = binExec('secret-tool')

type KeyringRef = Pick<SecretRef, 'service' | 'username'>

/**
 * Every item engined reads, writes or clears carries `service engined`, and a
 * config's `service` becomes the `name` attribute under it. A lookup or clear
 * matches only items holding all the given attributes, so no config can point
 * engined at another program's login item.
 */
export const ENGINED_KEYRING_SERVICE = 'engined'

function attributes(ref: KeyringRef): string[] {
  return ['service', ENGINED_KEYRING_SERVICE, 'name', ref.service, 'username', ref.username]
}

const label = (ref: KeyringRef): string => `engined ${ref.service}/${ref.username}`

function storeFix(ref: KeyringRef): string {
  return `secret-tool store --label='${label(ref)}' ${attributes(ref).join(' ')}`
}

/**
 * Secrets stored before the prefix sit at `service <service> username
 * <username>`, where nothing tells engined's own item from another program's.
 * Only the refs the config named the first time a prefixed build ran may be
 * read there, once each; a ref first named later never is.
 */
function legacySecretsFile(): string {
  return join(stateDir(), 'keyring-legacy.json')
}

const refKey = (ref: KeyringRef): string => JSON.stringify([ref.service, ref.username])

function pendingLegacy(file: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

/** Records the config's refs as movable, once: a file already there is never widened. */
export function seedLegacySecrets(
  config: {
    upstreams: readonly { secret?: KeyringRef }[]
    potluck?: { secret: KeyringRef }
  },
  file: string = legacySecretsFile(),
): void {
  const refs = [
    ...config.upstreams.flatMap((u) => (u.secret === undefined ? [] : [refKey(u.secret)])),
    ...(config.potluck === undefined ? [] : [refKey(config.potluck.secret)]),
  ]
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify([...new Set(refs)]), { flag: 'wx' })
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) {
      process.stderr.write(`keyring: could not record which secrets to move: ${errMessage(err)}\n`)
    }
  }
}

function settleLegacy(ref: KeyringRef, file: string): void {
  const pending = pendingLegacy(file)
  if (pending.includes(refKey(ref))) {
    writeFileAtomic(file, JSON.stringify(pending.filter((k) => k !== refKey(ref))))
  }
}

const LOCKED_FIX = 'keyring is locked; resolves automatically once the operator signs in'

/** The prefixed item, or on a miss, a pending ref's old item moved under the prefix. */
export async function resolveSecret(
  ref: KeyringRef,
  exec: Exec = secretExec,
  legacyFile: string = legacySecretsFile(),
): Promise<SecretOutcome> {
  const outcome = await lookup(ref, exec, attributes(ref))
  if (
    outcome.ok ||
    outcome.reason === 'locked' ||
    !pendingLegacy(legacyFile).includes(refKey(ref))
  ) {
    return outcome
  }
  const legacy = await lookup(ref, exec, ['service', ref.service, 'username', ref.username])
  if (legacy.ok) {
    await storeSecret(ref, legacy.value, exec, legacyFile)
    return legacy
  }
  if (legacy.reason === 'missing') {
    settleLegacy(ref, legacyFile)
  }
  return outcome
}

async function lookup(ref: KeyringRef, exec: Exec, attrs: string[]): Promise<SecretOutcome> {
  const result = await exec(['lookup', ...attrs])
  const value = result.stdout.trim()
  if (result.exitCode === 0 && value.length > 0) {
    return { ok: true, value }
  }
  /**
   * `secret-tool` prints nothing on either stream for a clean "no such item".
   * Any real service or unlock-prompt failure lands a message on stderr, so
   * a non-empty stderr is the locked/unavailable signal and an empty one is
   * a genuinely missing entry. Recorded from `secret-tool lookup` against a
   * nonexistent entry (exit 1, empty stdout, empty stderr) versus against an
   * unreachable Secret Service (exit 1, empty stdout, `secret-tool: Could not
   * connect: …` on stderr).
   */
  if (result.stderr.trim().length > 0) {
    return { ok: false, reason: 'locked', fix: LOCKED_FIX }
  }
  return { ok: false, reason: 'missing', fix: storeFix(ref) }
}

/** The value goes on stdin, never argv: argv is world-readable in /proc. Replaces an item with the same attributes. */
export async function storeSecret(
  ref: KeyringRef,
  value: string,
  exec: Exec = secretExec,
  legacyFile: string = legacySecretsFile(),
): Promise<{ ok: boolean; error?: string }> {
  const result = await exec(['store', `--label=${label(ref)}`, ...attributes(ref)], value)
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.trim() || `exit ${result.exitCode}` }
  }
  settleLegacy(ref, legacyFile)
  return { ok: true }
}

/**
 * Drops the prefixed item and never the old one, which another program may
 * share. Already-absent is success: `secret-tool clear` exits 1 with empty
 * stderr when there is nothing to delete.
 */
export async function clearSecret(
  ref: KeyringRef,
  exec: Exec = secretExec,
  legacyFile: string = legacySecretsFile(),
): Promise<{ ok: boolean; error?: string }> {
  settleLegacy(ref, legacyFile)
  const result = await exec(['clear', ...attributes(ref)])
  const stderr = result.stderr.trim()
  return result.exitCode === 0 || stderr === '' ? { ok: true } : { ok: false, error: stderr }
}
