import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { clearSecret, resolveSecret, storeSecret } from '../../src/secrets.ts'
import type { SecretRef } from '../../src/types.ts'
import { LOCAL } from './exclusive.ts'

/**
 * A real round trip against the real keyring, scoped to a throwaway service
 * name so it can never collide with an operator-stored credential. Seeded
 * before every test, not once for the file: the missing-entry test deletes
 * the same entry the resolve test reads, so seeding once would make this
 * file's result depend on the order its tests happen to run in.
 */
const REF: SecretRef = {
  service: 'engined-test-scratch',
  username: 'engined-test-scratch',
  header: 'Authorization',
}
const SCRATCH_VALUE = 'engined-test-scratch-value'

async function clearScratch(): Promise<void> {
  await clearSecret(REF)
}

async function storeScratch(value: string): Promise<boolean> {
  return (await storeSecret(REF, value)).ok
}

describe.skipIf(!LOCAL)('resolveSecret (local)', () => {
  beforeEach(async () => {
    await clearScratch()
    if (!(await storeScratch(SCRATCH_VALUE))) {
      throw new Error('secret-tool store failed for the scratch entry; is the keyring unlocked?')
    }
  })

  afterAll(async () => {
    await clearScratch()
  })

  test('resolves the stored scratch value', async () => {
    const outcome = await resolveSecret(REF)
    expect(outcome).toEqual({ ok: true, value: SCRATCH_VALUE })
  })

  test('reports missing after the entry is cleared', async () => {
    await clearScratch()
    const outcome = await resolveSecret(REF)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      throw new Error('unreachable: the test expects !outcome.ok')
    }
    expect(outcome.reason).toBe('missing')
  })
})
