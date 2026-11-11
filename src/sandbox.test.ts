/**
 * The floor is a mount table, so it is tested by mounting it: the argv is
 * checked for the ordering the guarantee rests on, and then actually run, so
 * a reordering that silently leaves the workdir writable fails here rather
 * than in production. `bwrap` is a real dependency and unprivileged, so there
 * is nothing to fake.
 */

import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentCli } from './agents.ts'
import { copyLogins, sandboxArgv, workdirGitDirs } from './sandbox.ts'
import { makeTestRoot } from './test-support.ts'

const BWRAP = '/usr/bin/bwrap'
const TEST_ROOT = makeTestRoot('engined-sandbox-test-')

/**
 * Outside /tmp on purpose: the sandbox's own tmpfs over /tmp would hide a
 * fake home there whether or not the home mask worked, and prove nothing.
 */
const HOME_ROOT = mkdtempSync('/var/tmp/engined-sandbox-home-')
afterAll(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  return mkdtempSync(join(TEST_ROOT, prefix))
}

function run(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([...argv], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

function git(cwd: string, ...args: string[]): void {
  const { code, stderr } = run(['git', '-C', cwd, ...args])
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')}: ${stderr}`)
  }
}

const bwrapIt = run([BWRAP, '--ro-bind', '/', '/', '--', '/bin/true']).code === 0 ? test : test.skip

test('binds the whole filesystem read-only before carving anything back out', () => {
  const argv = sandboxArgv({ bwrap: BWRAP, home: '/h', workdir: '/w', argv: ['/bin/true'] })
  // Order is the mechanism: a later bind wins, so the read-only root has to be
  // first and the workdir's own read-only bind has to come after the home's.
  expect(argv.slice(0, 4)).toEqual([BWRAP, '--ro-bind', '/', '/'])
  expect(argv.indexOf('--bind')).toBeLessThan(argv.lastIndexOf('--ro-bind'))
  expect(argv.slice(argv.lastIndexOf('--ro-bind'))).toEqual([
    '--ro-bind',
    '/w',
    '/w',
    '--die-with-parent',
    '--',
    '/bin/true',
  ])
  expect(argv).toEqual(
    expect.arrayContaining([
      '--tmpfs',
      '/run',
      '--unshare-ipc',
      '--unshare-pid',
      '--unshare-uts',
      '--new-session',
      '--cap-drop',
      'ALL',
    ]),
  )
})

bwrapIt('refuses a write into the workdir, which is the whole guarantee', () => {
  const workdir = scratch('engined-sandbox-work-')
  const home = scratch('engined-sandbox-home-')
  writeFileSync(join(workdir, 'seed.txt'), 'pre-existing\n')
  const { code, stderr } = run(
    sandboxArgv({
      bwrap: BWRAP,
      home,
      workdir,
      argv: ['/bin/sh', '-c', `printf x > ${workdir}/written.txt`],
    }),
  )
  expect(code).not.toBe(0)
  expect(stderr).toContain('Read-only file system')
  expect(existsSync(join(workdir, 'written.txt'))).toBe(false)
})

bwrapIt('refuses to overwrite a file that already exists, not merely to create one', async () => {
  const workdir = scratch('engined-sandbox-work-')
  const home = scratch('engined-sandbox-home-')
  const seed = join(workdir, 'seed.txt')
  writeFileSync(seed, 'pre-existing\n')
  const { code } = run(
    sandboxArgv({ bwrap: BWRAP, home, workdir, argv: ['/bin/sh', '-c', `printf x > ${seed}`] }),
  )
  expect(code).not.toBe(0)
  expect(await Bun.file(seed).text()).toBe('pre-existing\n')
})

bwrapIt('leaves the agent its own state directory writable, or it cannot cache anything', () => {
  const workdir = scratch('engined-sandbox-work-')
  const home = scratch('engined-sandbox-home-')
  const { code } = run(
    sandboxArgv({
      bwrap: BWRAP,
      home,
      workdir,
      argv: ['/bin/sh', '-c', `printf x > ${home}/session.json`],
    }),
  )
  expect(code).toBe(0)
  expect(existsSync(join(home, 'session.json'))).toBe(true)
})

bwrapIt(
  'gives a writable temp directory, since an agent that cannot write one looks broken',
  () => {
    const workdir = scratch('engined-sandbox-work-')
    const home = scratch('engined-sandbox-home-')
    const { code } = run(
      sandboxArgv({ bwrap: BWRAP, home, workdir, argv: ['/bin/sh', '-c', 'printf x > /tmp/t'] }),
    )
    expect(code).toBe(0)
  },
)

test('masks the operator home before binding anything back, and binds the workdir last', () => {
  const home = '/home/op'
  const argv = sandboxArgv({
    bwrap: BWRAP,
    home: `${home}/.local/state/engined/agentic-home/claude/launch-1`,
    cache: `${home}/.local/state/engined/bun-install`,
    workdir: `${home}/src/repo`,
    argv: [`${home}/.bun/bin/bunx`, 'pkg@1'],
    readOnly: [`${home}/.local/state/engined/agentic-mcp-empty.json`],
    operatorHome: home,
  })
  const mask = argv.indexOf(home)
  expect(argv[mask - 1]).toBe('--tmpfs')
  // Every mount naming a path under the home comes after the mask, or the mask would hide it.
  const underHome = argv.flatMap((token, i) => (token.startsWith(`${home}/`) ? [i] : []))
  const launched = argv.indexOf('--')
  for (const at of underHome.filter((i) => i < launched)) {
    expect(at).toBeGreaterThan(mask)
  }
  expect(argv).toEqual(expect.arrayContaining([`${home}/.bun/bin`]))
  expect(argv.slice(argv.lastIndexOf('--ro-bind'), launched)).toEqual([
    '--ro-bind',
    `${home}/src/repo`,
    `${home}/src/repo`,
    '--die-with-parent',
  ])
  // A path outside the home is visible through the root bind already, and
  // re-binding /bin, a symlink on merged-/usr systems, would fail the launch.
  const outside = sandboxArgv({
    bwrap: BWRAP,
    home: '/h',
    workdir: '/w',
    argv: ['/bin/sh'],
    operatorHome: home,
  })
  expect(outside).not.toContain('/bin')
})

test('copies a login into the launch home 0600, and an absent one is no error', () => {
  const operator = scratch('engined-sandbox-op-')
  const launch = scratch('engined-sandbox-launch-')
  mkdirSync(join(operator, '.claude'))
  writeFileSync(join(operator, '.claude', '.credentials.json'), '{"canary":1}', { mode: 0o644 })
  const logins = [...(agentCli('claude')?.logins ?? []), ...(agentCli('cursor')?.logins ?? [])]
  expect(logins).toHaveLength(2)

  copyLogins(launch, logins, operator)

  const copied = join(launch, '.claude', '.credentials.json')
  expect(Bun.file(copied).size).toBe('{"canary":1}'.length)
  expect(statSync(copied).mode % 0o1000).toBe(0o600)
  // cursor's login is absent from this operator home, so nothing is written for it.
  expect(existsSync(join(launch, 'config', 'cursor', 'auth.json'))).toBe(false)
})

test("resolves a linked worktree's git dir and its common dir, both outside the workdir", () => {
  const repo = scratch('engined-sandbox-repo-')
  const gitDir = join(repo, '.git', 'worktrees', 'wt')
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(gitDir, 'commondir'), '../..\n')
  const worktree = scratch('engined-sandbox-wt-')
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`)
  // A submodule names its git dir relatively, and has no commondir.
  const submodule = join(repo, 'sub')
  mkdirSync(join(repo, '.git', 'modules', 'sub'), { recursive: true })
  mkdirSync(submodule)
  writeFileSync(join(submodule, '.git'), 'gitdir: ../.git/modules/sub\n')

  expect(workdirGitDirs(worktree)).toEqual([join(repo, '.git'), gitDir])
  expect(workdirGitDirs(submodule)).toEqual([join(repo, '.git', 'modules', 'sub')])
  // A plain checkout's .git is inside the workdir, and a stale pointer binds nothing.
  expect(workdirGitDirs(repo)).toEqual([])
  writeFileSync(join(worktree, '.git'), 'gitdir: /nonexistent/engined\n')
  expect(workdirGitDirs(worktree)).toEqual([])
})

bwrapIt('hides a file under the operator home that the workdir does not cover', () => {
  const home = mkdtempSync(join(HOME_ROOT, 'op-'))
  writeFileSync(join(home, 'secret.txt'), 'canary\n')
  const workdir = join(home, 'src', 'repo')
  mkdirSync(workdir, { recursive: true })
  writeFileSync(join(workdir, 'seed.txt'), 'visible\n')
  const state = join(home, '.local', 'state', 'launch')
  mkdirSync(state, { recursive: true })
  const read = (operatorHome: string) =>
    run(
      sandboxArgv({
        bwrap: BWRAP,
        home: state,
        workdir,
        operatorHome,
        argv: [
          '/bin/sh',
          '-c',
          `cat ${workdir}/seed.txt && printf x > ${state}/w && cat ${home}/secret.txt`,
        ],
      }),
    )

  // The control: unmasked, the same command reads the file.
  expect(read(scratch('engined-sandbox-other-')).stdout).toContain('canary')
  const masked = read(home)
  expect(masked.stdout).toBe('visible\n')
  expect(masked.stderr).toContain('No such file')
  expect(existsSync(join(state, 'w'))).toBe(true)
})

bwrapIt('git reads a worktree whose git dir sits under the masked home', () => {
  const home = mkdtempSync(join(HOME_ROOT, 'op-'))
  const repo = join(home, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q')
  git(
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'seeded',
  )
  const worktree = join(scratch('engined-sandbox-wt-'), 'wt')
  git(repo, 'worktree', 'add', '-q', worktree)

  const { code, stdout, stderr } = run(
    sandboxArgv({
      bwrap: BWRAP,
      home: scratch('engined-sandbox-state-'),
      workdir: worktree,
      operatorHome: home,
      argv: ['/usr/bin/git', '-C', worktree, 'log', '-1', '--format=%s'],
    }),
  )

  expect(stderr).toBe('')
  expect(code).toBe(0)
  expect(stdout).toBe('seeded\n')
})
