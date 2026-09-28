import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { observeAgentVersion } from './agentVersion.ts'

/** A real, spawnable `--version` script -- writing a fresh mtime each time so two calls a few CPU cycles apart cannot land on the same millisecond. */
function writeFakeBinary(path: string, version: string, mtimeMs: number): void {
  writeFileSync(path, `#!/bin/sh\necho ${version}\n`)
  chmodSync(path, 0o755)
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
}

describe('observeAgentVersion', () => {
  test('a binary replaced at the same path is re-observed rather than served the stale cached version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engined-agent-version-'))
    const path = join(dir, 'agent')

    writeFakeBinary(path, 'v1.0.0', 1_000_000)
    const first = await observeAgentVersion('cursor', 'unused', undefined, () => path)
    expect(first).toEqual({ ok: true, version: 'v1.0.0' })

    writeFakeBinary(path, 'v2.0.0', 2_000_000)
    const second = await observeAgentVersion('cursor', 'unused', undefined, () => path)
    expect(second).toEqual({ ok: true, version: 'v2.0.0' })
  })
})
