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
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kill, pid } from 'node:process'
import { assignEnv, envString } from './env.ts'

const PREFIX = 'engined-run-'

// The run's own process id leads its folder name, so a later run can tell a folder whose run was killed before afterAll
// (a timeout, Ctrl+C) from one still in use, and removes it.
function alive(id: number): boolean {
  try {
    kill(id, 0)
    return true
  } catch (e) {
    return e instanceof Error && 'code' in e && e.code === 'EPERM'
  }
}

for (const name of readdirSync(tmpdir())) {
  const owner = Number(name.slice(PREFIX.length).split('-')[0])
  if (name.startsWith(PREFIX) && Number.isInteger(owner) && owner > 0 && !alive(owner)) {
    rmSync(join(tmpdir(), name), { recursive: true, force: true })
  }
}

const run = mkdtempSync(join(tmpdir(), `${PREFIX}${pid}-`))
assignEnv('TMPDIR', run)
if (envString('ENGINED_LOCAL') !== '1') {
  assignEnv('XDG_STATE_HOME', join(run, 'state'))
  assignEnv('XDG_CACHE_HOME', join(run, 'cache'))
}

afterAll((): void => {
  rmSync(run, { recursive: true, force: true })
})
