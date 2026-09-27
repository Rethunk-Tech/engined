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
import process from 'node:process'

const run = mkdtempSync(join(tmpdir(), 'engined-run-'))
process.env.TMPDIR = run
if (process.env.ENGINED_LOCAL !== '1') {
  process.env.XDG_STATE_HOME = join(run, 'state')
  process.env.XDG_CACHE_HOME = join(run, 'cache')
}

afterAll((): void => {
  rmSync(run, { recursive: true, force: true })
})
