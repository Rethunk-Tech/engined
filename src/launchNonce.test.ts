import { describe, expect, test } from 'bun:test'
import { LAUNCH_NONCE_RE, launchScopedBaseUrl, mintLaunchNonce } from './launchNonce.ts'

describe('mintLaunchNonce', () => {
  test('32 lowercase hex, matching the launch-scoped path', () => {
    const nonce = mintLaunchNonce()
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(nonce).not.toContain('-')
    const match = LAUNCH_NONCE_RE.exec(`/openai/v1/${nonce}/chat/completions`)
    expect(match?.[1]).toBe(nonce)
    expect(match?.[2]).toBe('/chat/completions')
  })
})

describe('LAUNCH_NONCE_RE', () => {
  const ok = 'a'.repeat(32)

  test.each([
    [`/openai/v1/${ok}/models`, ok, '/models'],
    [`/openai/v1/${ok}`, undefined, undefined],
    ['/openai/v1/chat/completions', undefined, undefined],
    [`/openai/v1/${'A'.repeat(32)}/x`, undefined, undefined],
    [`/openai/v1/${'ab'.repeat(8)}/x`, undefined, undefined],
  ] as const)('%s', (path, nonce, rest) => {
    const match = LAUNCH_NONCE_RE.exec(path)
    expect(match?.[1]).toBe(nonce)
    expect(match?.[2]).toBe(rest)
  })
})

describe('launchScopedBaseUrl', () => {
  test('this box, this port, this nonce', () => {
    expect(launchScopedBaseUrl(29_200, 'ab'.repeat(16))).toBe(
      `http://127.0.0.1:29200/openai/v1/${'ab'.repeat(16)}`,
    )
  })
})
