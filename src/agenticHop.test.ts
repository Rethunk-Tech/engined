import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

import type { AgenticSpawn } from './agentic.ts'
import { CLAUDE_SPEC, chatRequest, PASSING_PROBE } from './doorFixtures.ts'
import { createDoor } from './main.ts'
import {
  BUNX,
  clearVerifiedVersion,
  config,
  engine,
  makeTestRoot,
  route,
  writeEngineSpec,
} from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-agentic-hop-test-')

const DELTA_LINE = `${JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: 'hi' },
  },
})}\n`

test('a streamed launch whose child then rejects does not surface unhandledRejection', async () => {
  const id = 'claude-abort-handoff'
  clearVerifiedVersion(id)
  const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
  writeEngineSpec(root, id, CLAUDE_SPEC)
  const workdir = mkdtempSync(join(TEST_ROOT, 'engined-workdir-'))
  const cfg = config({
    routes: [route({ engine: id, model: 'assistant', upstream: null })],
    engines: [engine({ id, agent_version: '1.2.3' })],
  })
  const spawn: AgenticSpawn = (_argv, opts) => {
    opts.onStdout?.(DELTA_LINE)
    return Promise.reject(new Error('client abort'))
  }
  const seen: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    seen.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, agenticProbeRunner: PASSING_PROBE },
      { agenticSpawn: spawn, write: () => undefined },
    )
    const res = await door.fetch(
      chatRequest({
        model: `@/${id}/assistant`,
        messages: [{ role: 'user', content: 'hi' }],
        workdir,
        stream: true,
      }),
    )
    expect(res.status).toBe(200)
    await res.text().catch(() => undefined)
    await Bun.sleep(20)
    expect(seen).toEqual([])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    clearVerifiedVersion(id)
  }
})
