/**
 * The sandbox paths that are refused rather than followed: a login named
 * outside the operator home or copied outside the launch home, a workdir over
 * engined's own state, and the defaults the launch environment is built from.
 * Everything here is the real function against a real temporary tree; nothing
 * about bwrap is faked.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assignEnv, clearEnv, envString } from './env.ts'
import {
  copyLogins,
  resolveBwrap,
  sandboxArgv,
  sandboxEnv,
  sandboxLaunchHome,
  workdirForbidden,
  workdirGitDirs,
} from './sandbox.ts'
import { makeTestRoot } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-sandbox-paths-')

/** Outside /tmp, so the sandbox tmpfs over it cannot be what hides a fake home. */
const HOME_ROOT = mkdtempSync(join(homedir(), 'engined-sandbox-paths-home-'))
afterAll(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true })
})

/** Sets `vars` for the body and puts every one back afterwards, via the sanctioned test hook. */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const previous = Object.keys(vars).map((name) => [name, envString(name)] as const)
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) {
      clearEnv(name)
    } else {
      assignEnv(name, value)
    }
  }
  try {
    body()
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        clearEnv(name)
      } else {
        assignEnv(name, value)
      }
    }
  }
}

function scratch(prefix: string): string {
  return mkdtempSync(join(TEST_ROOT, prefix))
}

function operatorHome(prefix: string): string {
  return mkdtempSync(join(HOME_ROOT, prefix))
}

describe('copyLogins refusals', () => {
  test('a login named above the operator home is refused, not resolved', () => {
    const operator = operatorHome('op-')
    const launch = scratch('launch-')
    expect(() =>
      copyLogins(launch, [{ from: '../id_ed25519', to: 'id_ed25519' }], operator),
    ).toThrow(/login \.\.\/id_ed25519 is outside the operator home/)
  })

  test('the operator home itself as a login is refused: it is not a file to copy', () => {
    const operator = operatorHome('op-')
    const launch = scratch('launch-')
    expect(() => copyLogins(launch, [{ from: '.', to: 'x' }], operator)).toThrow(
      /login \. is outside the operator home/,
    )
  })

  test('a login reached through a directory symlinked out of the home is refused', () => {
    const operator = operatorHome('op-')
    const launch = scratch('launch-')
    const outside = scratch('secret-')
    writeFileSync(join(outside, '.credentials.json'), '{"canary":1}')
    symlinkSync(outside, join(operator, '.claude'))
    expect(() =>
      copyLogins(
        launch,
        [{ from: '.claude/.credentials.json', to: '.claude/.credentials.json' }],
        operator,
      ),
    ).toThrow(/login \.claude\/\.credentials\.json is outside the operator home/)
  })

  test('a login that is a directory is refused rather than copied', () => {
    const operator = operatorHome('op-')
    const launch = scratch('launch-')
    mkdirSync(join(operator, '.claude', '.credentials.json'), { recursive: true })
    expect(() =>
      copyLogins(
        launch,
        [{ from: '.claude/.credentials.json', to: '.claude/.credentials.json' }],
        operator,
      ),
    ).toThrow(/is not a regular file/)
  })

  test('a destination escaping the launch home is refused before anything is written', () => {
    const operator = operatorHome('op-')
    const launch = scratch('launch-')
    mkdirSync(join(operator, '.claude'), { recursive: true })
    writeFileSync(join(operator, '.claude', 'creds.json'), '{"canary":1}')
    expect(() =>
      copyLogins(launch, [{ from: '.claude/creds.json', to: '../creds.json' }], operator),
    ).toThrow(/is outside the launch home/)
    expect(() => copyLogins(launch, [{ from: '.claude/creds.json', to: '.' }], operator)).toThrow(
      /is outside the launch home/,
    )
  })
})

describe('workdirForbidden over engined’s own paths', () => {
  test('a workdir inside or above the state dir is refused as a sensitive path', () => {
    const stateHome = '/var/lib/engined-tables-state'
    const configHome = '/var/lib/engined-tables-config'
    withEnv({ XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome }, () => {
      const home = operatorHome('op-')
      for (const path of [
        join(stateHome, 'engined'),
        join(stateHome, 'engined', 'voices'),
        stateHome,
        join(configHome, 'engined'),
        join(configHome, 'engined', 'config.toml'),
      ]) {
        expect(workdirForbidden(path, home)).toContain('covers a sensitive path')
      }
      expect(workdirForbidden('/var/lib/unrelated', home)).toBeUndefined()
    })
  })
})

describe('workdirGitDirs on a .git that is not a readable pointer', () => {
  test('a .git file that cannot be read binds nothing', () => {
    const workdir = scratch('unreadable-git-')
    writeFileSync(join(workdir, '.git'), 'gitdir: /nonexistent\n')
    chmodSync(join(workdir, '.git'), 0o000)
    try {
      expect(workdirGitDirs(workdir)).toEqual([])
    } finally {
      chmodSync(join(workdir, '.git'), 0o644)
    }
  })

  test('a .git file with no gitdir line binds nothing', () => {
    const workdir = scratch('plain-git-')
    writeFileSync(join(workdir, '.git'), 'not a git pointer\n')
    expect(workdirGitDirs(workdir)).toEqual([])
  })
})

describe('resolveBwrap', () => {
  test('ENGINED_BWRAP wins when set, and an empty value falls through to the PATH search', () => {
    withEnv({ ENGINED_BWRAP: '/opt/engined/bwrap' }, () => {
      expect(resolveBwrap()).toBe('/opt/engined/bwrap')
      clearEnv('ENGINED_BWRAP')
      expect(resolveBwrap()).toBe(Bun.which('bwrap'))
    })
    withEnv({ ENGINED_BWRAP: '' }, () => {
      expect(resolveBwrap()).toBe(Bun.which('bwrap'))
    })
  })
})

describe('sandboxEnv', () => {
  test('every state variable points inside the launch home, and the cache is its own', () => {
    const home = scratch('launch-home-')
    expect(sandboxEnv(home)).toEqual({
      HOME: home,
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: join(home, 'state'),
      XDG_CACHE_HOME: join(home, 'cache'),
      TMPDIR: '/tmp',
      BUN_TMPDIR: '/tmp',
      BUN_INSTALL: join(home, 'bun'),
    })
    expect(sandboxEnv(home, '/state/bun-install').BUN_INSTALL).toBe('/state/bun-install')
  })

  test('each launch gets a fresh home under the agent’s own state dir', () => {
    const agent = 'tables-agent'
    const first = sandboxLaunchHome(agent)
    const second = sandboxLaunchHome(agent)
    expect(first).not.toBe(second)
    expect(first).toContain(join('agentic-home', agent))
    expect(first).toContain('launch-')
  })
})

describe('a mask that is not there', () => {
  test('a nonexistent sandbox_mask path adds no tmpfs at all', () => {
    const launch = sandboxArgv({
      bwrap: '/usr/bin/bwrap',
      home: '/h',
      workdir: '/w',
      sandboxMask: ['/nonexistent-engined-mask'],
      operatorHome: '/home/op',
      argv: ['/bin/true'],
    })
    // bwrap would refuse a --tmpfs whose target does not exist, so the path is
    // dropped rather than passed through.
    expect(launch).not.toContain('/nonexistent-engined-mask')
  })

  test('a mask that is a file is dropped too: tmpfs needs a directory', () => {
    const file = join(scratch('mask-file-'), 'f')
    writeFileSync(file, '')
    const launch = sandboxArgv({
      bwrap: '/usr/bin/bwrap',
      home: '/h',
      workdir: '/w',
      sandboxMask: [file],
      operatorHome: '/home/op',
      argv: ['/bin/true'],
    })
    expect(launch).not.toContain(file)
  })
})
