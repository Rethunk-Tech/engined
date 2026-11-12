/**
 * The floor is a mount table, so it is tested by mounting it: the argv is
 * checked for the ordering the guarantee rests on, and then actually run, so
 * a reordering that silently leaves the workdir writable fails here rather
 * than in production. `bwrap` is a real dependency and unprivileged, so there
 * is nothing to fake.
 */

import { afterAll, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentCli } from './agents.ts'
import { copyLogins, sandboxArgv, workdirForbidden, workdirGitDirs } from './sandbox.ts'
import { makeTestRoot } from './test-support.ts'

const BWRAP = '/usr/bin/bwrap'
const TEST_ROOT = makeTestRoot('engined-sandbox-test-')

/**
 * Outside /tmp and /var/tmp on purpose: the sandbox tmpfs over either would
 * hide a fake home there whether or not the home mask worked, and prove
 * nothing.
 */
const HOME_ROOT = mkdtempSync(join(homedir(), 'engined-sandbox-home-'))
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
  const bwrapAt = argv.indexOf(BWRAP)
  expect(argv.slice(bwrapAt, bwrapAt + 4)).toEqual([BWRAP, '--ro-bind', '/', '/'])
  expect(argv.indexOf('--bind')).toBeLessThan(argv.lastIndexOf('--ro-bind-fd'))
  expect(argv.slice(argv.lastIndexOf('--ro-bind-fd'))).toEqual([
    '--ro-bind-fd',
    '9',
    '/w',
    '--chdir',
    '/w',
    '--die-with-parent',
    '--',
    '/bin/true',
  ])
  expect(argv).toEqual(
    expect.arrayContaining([
      '--tmpfs',
      '/run',
      '--tmpfs',
      '/var/tmp',
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

test('tmpfs sandbox_mask paths before the workdir bind', () => {
  const argv = sandboxArgv({
    bwrap: BWRAP,
    home: '/h',
    workdir: '/usr/local/src/one',
    argv: ['/bin/true'],
    sandboxMask: ['/usr/local/src', '/mnt'],
    operatorHome: '/home/op',
  })
  const src = argv.indexOf('/usr/local/src')
  expect(argv[src - 1]).toBe('--tmpfs')
  const launched = argv.indexOf('--', argv.indexOf(BWRAP))
  expect(src).toBeLessThan(argv.lastIndexOf('--ro-bind-fd'))
  expect(src).toBeLessThan(launched)
  expect(argv.slice(argv.lastIndexOf('--ro-bind-fd'), launched)).toEqual([
    '--ro-bind-fd',
    '9',
    '/usr/local/src/one',
    '--chdir',
    '/usr/local/src/one',
    '--die-with-parent',
  ])
})

bwrapIt('sandbox_mask hides siblings of the workdir but not the workdir itself', () => {
  const root = scratch('engined-sandbox-mask-')
  const workdir = join(root, 'one')
  const sibling = join(root, 'two')
  mkdirSync(workdir)
  mkdirSync(sibling)
  writeFileSync(join(workdir, 'seed.txt'), 'visible\n')
  writeFileSync(join(sibling, '.env'), 'canary\n')
  const home = scratch('engined-sandbox-home-')
  const { code, stdout } = run(
    sandboxArgv({
      bwrap: BWRAP,
      home,
      workdir,
      sandboxMask: [root],
      argv: ['/bin/sh', '-c', `cat ${workdir}/seed.txt; cat ${sibling}/.env`],
    }),
  )
  expect(stdout).toContain('visible')
  expect(stdout).not.toContain('canary')
  expect(code).not.toBe(0)
})

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
  const bwrapAt = argv.indexOf(BWRAP)
  const launched = argv.indexOf('--', bwrapAt)
  for (const at of underHome.filter((i) => i > bwrapAt && i < launched)) {
    expect(at).toBeGreaterThan(mask)
  }
  expect(argv).toEqual(expect.arrayContaining([`${home}/.bun/bin`]))
  expect(argv.slice(argv.lastIndexOf('--ro-bind-fd'), launched)).toEqual([
    '--ro-bind-fd',
    '9',
    `${home}/src/repo`,
    '--chdir',
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

  expect(workdirGitDirs(worktree)).toEqual([])
  writeFileSync(join(gitDir, 'gitdir'), `${join(worktree, '.git')}\n`)
  expect(workdirGitDirs(worktree)).toEqual([join(repo, '.git'), gitDir])
  // A submodule has no gitdir backlink, so a crafted pointer cannot bind an arbitrary path.
  expect(workdirGitDirs(submodule)).toEqual([])
  // A plain checkout's .git is inside the workdir, and a stale pointer binds nothing.
  expect(workdirGitDirs(repo)).toEqual([])
  writeFileSync(join(worktree, '.git'), 'gitdir: /nonexistent/engined\n')
  expect(workdirGitDirs(worktree)).toEqual([])
})

test('a forged commondir cannot bind a hidden home directory', () => {
  const home = scratch('engined-sandbox-op-')
  mkdirSync(join(home, '.config', 'gh'), { recursive: true })
  const workdir = scratch('engined-sandbox-forged-')
  const gitDir = join(workdir, 'fake')
  mkdirSync(gitDir)
  writeFileSync(join(workdir, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'gitdir'), `${join(workdir, '.git')}\n`)
  writeFileSync(join(gitDir, 'commondir'), `${join(home, '.config', 'gh')}\n`)
  expect(workdirGitDirs(workdir, home)).toEqual([])
})

test("a .git pointer at an arbitrary path is not bound without git's worktree backlink", () => {
  const secret = scratch('engined-sandbox-secret-')
  writeFileSync(join(secret, 'id_ed25519'), 'key\n')
  const workdir = scratch('engined-sandbox-forged-')
  writeFileSync(join(workdir, '.git'), `gitdir: ${secret}\n`)
  expect(workdirGitDirs(workdir)).toEqual([])
})

test('refuses a workdir that is, contains, or sits inside a sensitive path', () => {
  const home = scratch('engined-sandbox-op-')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  mkdirSync(join(home, 'src', 'repo'), { recursive: true })
  expect(workdirForbidden(home, home)).toBeDefined()
  expect(workdirForbidden(join(home, '.ssh'), home)).toBeDefined()
  expect(workdirForbidden(join(home, '.ssh', 'keys'), home)).toBeDefined()
  // The filesystem root contains the home; its trailing separator must not defeat the prefix check.
  expect(workdirForbidden('/', home)).toBeDefined()
  expect(workdirForbidden('//', home)).toBeDefined()
  expect(workdirForbidden(join(home, 'src', 'repo'), home)).toBeUndefined()
  expect(workdirForbidden('/usr/local/src/com.github/Org/repo', home)).toBeUndefined()
  for (const root of ['.cursor', '.claude']) {
    const tree = join(home, root, 'worktrees', 'repo', 'wt1')
    mkdirSync(tree, { recursive: true })
    expect(workdirForbidden(tree, home)).toBeUndefined()
    expect(workdirForbidden(join(home, root), home)).toBeDefined()
    expect(workdirForbidden(join(home, root, 'worktrees'), home)).toBeDefined()
  }
  for (const rel of [
    '.gnupg',
    '.aws',
    join('.local', 'share', 'keyrings'),
    join('.config', 'gh'),
    '.docker',
    '.kube',
    '.mozilla',
    '.pki',
  ]) {
    expect(workdirForbidden(join(home, rel), home)).toBeDefined()
  }
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

bwrapIt('hides a unix socket under /var/tmp so a host browser is not reachable', async () => {
  const workdir = scratch('engined-sandbox-work-')
  const home = scratch('engined-sandbox-home-')
  const dir = mkdtempSync('/var/tmp/engined-sandbox-sock-')
  const sock = join(dir, 'SingletonSocket')
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(sock, resolve)
    })
    expect(existsSync(sock)).toBe(true)
    const { code } = run(
      sandboxArgv({
        bwrap: BWRAP,
        home,
        workdir,
        argv: ['/bin/sh', '-c', `test -S ${sock}`],
      }),
    )
    expect(code).not.toBe(0)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
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

test("a worktree's git dir under a sandbox_mask path is bound back after the mask", () => {
  const masked = scratch('engined-sandbox-masked-')
  const gitDir = join(masked, 'repo', '.git', 'worktrees', 'wt')
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(gitDir, 'commondir'), '../..\n')
  const worktree = scratch('engined-sandbox-wt-')
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'gitdir'), `${join(worktree, '.git')}\n`)

  const argv = sandboxArgv({
    bwrap: BWRAP,
    home: scratch('engined-sandbox-state-'),
    workdir: worktree,
    operatorHome: scratch('engined-sandbox-op-'),
    sandboxMask: [masked],
    argv: ['/usr/bin/git'],
  })

  expect(argv.lastIndexOf(gitDir)).toBeGreaterThan(argv.indexOf(masked))
})

test.each([
  '/proc',
  '/proc/self',
  '/sys',
  '/dev/shm',
  '/run',
  `/run/user/${process.getuid?.() ?? 1000}`,
  '/tmp',
  '/tmp/tmux-1000',
  '/var/tmp',
])('refuses runtime workdir %s that the workdir bind would re-expose over the masks', (path) => {
  expect(workdirForbidden(path)).toContain('runtime directory')
})

test('the pin prelude runs the command when each directory is what it was validated as, and refuses with 125 when it is not', () => {
  const real = mkdtempSync(join(TEST_ROOT, 'pin-real-'))
  const link = join(TEST_ROOT, 'pin-link')
  rmSync(link, { force: true })
  symlinkSync(real, link)
  const argv = sandboxArgv({ bwrap: BWRAP, home: '/h', workdir: real, argv: ['/bin/true'] })
  const dirsAt = argv.indexOf('_') + 1
  const end = argv.indexOf('--')
  const launch = (dirs: string[]) =>
    Bun.spawnSync([...argv.slice(0, dirsAt), ...dirs, '--', '/bin/echo', 'ran'], {
      stderr: 'pipe',
    })

  expect(argv.slice(dirsAt, end)).toContain(real)
  const answered = launch([real])
  expect(answered.exitCode).toBe(0)
  expect(answered.stdout.toString().trim()).toBe('ran')

  // The fd opened through the link resolves to the real directory, so the path
  // that was validated no longer names what was opened.
  const swapped = launch([link])
  expect(swapped.exitCode).toBe(125)
  expect(swapped.stderr.toString()).toContain('changed while launching')
  expect(swapped.stdout.toString()).toBe('')
})
