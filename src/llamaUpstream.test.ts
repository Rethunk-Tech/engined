import { expect, test } from 'bun:test'
import { ENGINE_ERROR_CHARS } from './http.ts'
import { LlamaUpstream } from './llamaUpstream.ts'

const lifecycle = {
  getStatus: () => ({ private_url: '127.0.0.1:9' }),
  reconcile: () => Promise.resolve({ state: 'running' as const }),
}

test('a non-JSON 400 on load does not throw SyntaxError', async () => {
  const body = `not-json ${'x'.repeat(ENGINE_ERROR_CHARS + 8)}`
  const upstream = new LlamaUpstream({
    engineId: 'llama',
    lifecycle,
    httpClient: () => Promise.resolve(new Response(body, { status: 400 })),
    readyTimeoutS: 1,
    pollIntervalMs: 1,
    ensureStarted: () => Promise.resolve(),
  })
  try {
    await upstream.loadAndWait('m')
    throw new Error('expected loadAndWait to throw')
  } catch (err) {
    expect(err instanceof SyntaxError).toBe(false)
    if (!(err instanceof Error)) {
      throw err
    }
    expect(err.message).toContain('load failed:')
    expect(err.message.includes(body)).toBe(false)
    expect(err.message).toContain('x'.repeat(ENGINE_ERROR_CHARS - 20))
  }
})
