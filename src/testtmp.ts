/**
 * Test preload (`bunfig.toml`): every `mkdtemp(tmpdir())` in the suite lands in
 * one per-run directory removed once all files finish, so a test that never
 * cleans up after itself still leaves nothing in `/tmp`, which is RAM.
 *
 * Outside the local tier, state and cache homes point into that directory too.
 * The live unit keeps its proved agent versions and caches under the real ones,
 * and a unit test that clears a proof would otherwise force the running door to
 * re-probe. The local tier keeps the real homes: it installs real agents into
 * the state cache and proves them under ids of its own.
 */
import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assignEnv, readEnv } from './env.ts'

const run = mkdtempSync(join(tmpdir(), 'engined-run-'))
assignEnv('TMPDIR', run)
if (readEnv('ENGINED_LOCAL') !== '1') {
  assignEnv('XDG_STATE_HOME', join(run, 'state'))
  assignEnv('XDG_CACHE_HOME', join(run, 'cache'))
}

afterAll((): void => {
  rmSync(run, { recursive: true, force: true })
})
