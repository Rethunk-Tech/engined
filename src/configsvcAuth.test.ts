import { expect, test } from 'bun:test'
import { createAuth, SESSION_COOKIE, SESSION_IDLE_MS } from './configsvcAuth.ts'

test('login sweeps idle sessions before minting a new one', async () => {
  const clock = { now: 1_000_000 }
  const auth = createAuth({ now: () => clock.now })
  const secret = auth.token as string
  const stale = await auth.login(secret, 'a')
  expect(typeof stale).toBe('string')
  clock.now += SESSION_IDLE_MS + 1
  const fresh = await auth.login(secret, 'a')
  expect(typeof fresh).toBe('string')
  expect(auth.authorize(`${SESSION_COOKIE}=${stale}`)).toBe(false)
  expect(auth.authorize(`${SESSION_COOKIE}=${fresh}`)).toBe(true)
})
