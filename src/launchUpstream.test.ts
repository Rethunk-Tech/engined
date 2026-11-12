import { expect, test } from 'bun:test'
import type { DoorContext } from './doorContext.ts'
import { MAX_JSON_BODY_BYTES, STATUS_FORBIDDEN, STATUS_PAYLOAD_TOO_LARGE } from './http.ts'
import { forwardLaunchUpstream } from './launchUpstream.ts'

const NONCE = 'a'.repeat(32)

function ctx(): DoorContext {
  return {
    launchUpstreams: new Map([[NONCE, 'u']]),
  } as DoorContext
}

function request(rest: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1/engined/v1/upstream/${NONCE}${rest}`, init)
}

test('the keyless forwarder refuses paths the agent does not use', async () => {
  const res = await forwardLaunchUpstream(ctx(), request('/v1/files'), NONCE, '/v1/files')
  expect(res.status).toBe(STATUS_FORBIDDEN)
})

test('the keyless forwarder refuses encoded slashes and dotted segments', async () => {
  const encoded = await forwardLaunchUpstream(
    ctx(),
    request('/v1/messages%2f../files'),
    NONCE,
    '/v1/messages/../files',
  )
  expect(encoded.status).toBe(STATUS_FORBIDDEN)
  const dotted = await forwardLaunchUpstream(
    ctx(),
    request('/v1/messages/../files'),
    NONCE,
    '/v1/messages/../files',
  )
  expect(dotted.status).toBe(STATUS_FORBIDDEN)
})

test('the keyless forwarder caps the body before it reaches the upstream', async () => {
  const res = await forwardLaunchUpstream(
    ctx(),
    request('/v1/messages', {
      method: 'POST',
      headers: { 'content-length': String(MAX_JSON_BODY_BYTES + 1) },
    }),
    NONCE,
    '/v1/messages',
  )
  expect(res.status).toBe(STATUS_PAYLOAD_TOO_LARGE)
})
