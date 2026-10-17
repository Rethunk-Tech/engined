import { expect, test } from 'bun:test'
import { banner } from './banner.ts'

test('banner distinguishes agreement, an unreloaded save, a stale daemon, a fault and no daemon', () => {
  const saved = 'a'.repeat(64)
  expect(banner({ savedSha: saved, running: { config_sha256: saved } }).kind).toBe('ok')
  const old = { config_sha256: 'b'.repeat(64) }
  expect(banner({ savedSha: saved, running: old, lastSavedSha: saved }).text).toBe(
    'saved but not reloaded',
  )
  expect(banner({ savedSha: saved, running: old }).text).toBe('engined is running an older config')
  const faulty = banner({ savedSha: saved, running: { ...old, config_error: 'bad key' } })
  expect(faulty).toEqual({ kind: 'error', text: 'engined reports config_error: bad key' })
  expect(banner({ savedSha: saved, running: undefined, unreachable: 'refused' }).text).toContain(
    'refused',
  )
})
