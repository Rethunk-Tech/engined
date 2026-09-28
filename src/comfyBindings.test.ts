/**
 * Direct unit coverage for the pure pieces `comfyProxy.test.ts` exercises
 * only through a real door: the key format, the age boundary, and the
 * `views` shape a stored binding round-trips.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  COMFY_KEY_SEP,
  comfyBindingsPath,
  comfyKey,
  expired,
  loadComfyBindings,
} from './comfyBindings.ts'
import { redirectStateHome } from './enginesFixtures.ts'
import { collectLines, makeTestRoot } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-comfy-bindings-')
afterAll(redirectStateHome(TEST_ROOT))

describe('comfyKey', () => {
  test('joins engine, origin and prompt id with the NUL separator', () => {
    expect(comfyKey('comfy', 'local', 'job-1')).toBe(
      `comfy${COMFY_KEY_SEP}local${COMFY_KEY_SEP}job-1`,
    )
  })

  test('two callers of the same engine never collide on the same prompt id', () => {
    expect(comfyKey('comfy', 'origin-a', 'job-1')).not.toBe(comfyKey('comfy', 'origin-b', 'job-1'))
  })
})

describe('expired', () => {
  const DayMs = 24 * 60 * 60 * 1000
  const WeekMs = 7 * DayMs

  test('a binding just under the week-long ttl is still live', () => {
    const now = Date.now()
    expect(expired(now - (WeekMs - 1), now)).toBe(false)
  })

  test('a binding at or past the ttl has aged out', () => {
    const now = Date.now()
    expect(expired(now - WeekMs, now)).toBe(true)
    expect(expired(now - WeekMs - 1, now)).toBe(true)
  })
})

describe('loadComfyBindings: the views a stored binding carries', () => {
  function stateWith(body: string): void {
    process.env.XDG_STATE_HOME = TEST_ROOT
    mkdirSync(dirname(comfyBindingsPath()), { recursive: true })
    writeFileSync(comfyBindingsPath(), body)
  }

  test('a well-formed views array is read back filename, subfolder and type', () => {
    stateWith(
      JSON.stringify({
        'comfy local job-views': {
          at: Date.now(),
          views: [{ filename: 'out.png', subfolder: 'sub', type: 'output' }],
        },
      }),
    )
    const { write } = collectLines()
    const table = loadComfyBindings(write)
    expect(table.get('comfy local job-views')?.views).toEqual([
      { filename: 'out.png', subfolder: 'sub', type: 'output' },
    ])
  })
})
