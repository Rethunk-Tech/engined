import { expect, test } from 'bun:test'
import { errorMessageOf, JSON_CONTENT_TYPE } from './http.ts'
import { bindDualFamily } from './main.ts'

test("Bun.serve's error handler answers JSON 500, not the HTML diagnostic page", async () => {
  const { v4, v6 } = bindDualFamily(() => {
    throw new Error('boom')
  }, 0)
  try {
    const res = await fetch(`http://127.0.0.1:${v4.port}/`)
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain(JSON_CONTENT_TYPE)
    expect(errorMessageOf(await res.json())).toBe('boom')
  } finally {
    v4.stop()
    v6.stop()
  }
})
