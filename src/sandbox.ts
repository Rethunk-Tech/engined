/**
 * The kernel floor every agentic launch runs under: the agent cannot write
 * outside its own state directory, and cannot read the operator's home.
 *
 * An agent's own configuration is not a floor. `opencode` exposes no tool or
 * permission flag at all, its only lever is a config file, and config is
 * discovered by walking UP from the working directory -- so any ancestor of
 * the workdir can hand `edit`, `bash` and `write` back. `claude` and `cursor`
 * do honour argv floors (`agenticArgs.ts`), and keep them, but a tool allowed
 * to read can read whatever the uid can: `Read` returns `~/.ssh` and `Grep`
 * returns `/proc/self/environ`. The door takes prompts from LAN hosts, so what
 * an agent may read has to come from something it cannot argue with.
 *
 * `bwrap` binds the filesystem read-only, masks the operator's home with an
 * empty tmpfs, masks `/run` and `/var/tmp` the same way (live unix sockets
 * live there -- docker, the user bus, Chromium SingletonSocket files that
 * hand a URL to the running browser), and binds back only what the launch
 * needs: the binary's own directory, a worktree's git dir, Bun's install
 * cache, the agent's writable state directory and, last, the workdir. A write
 * into the workdir fails with EROFS whatever a config file inside it claims,
 * and a read of anything else under the home finds nothing. Unprivileged user
 * namespaces are what make this reachable without root.
 *
 * What this floor does NOT close: outbound network, and the agent's own
 * environment. Under `pasta` the sandbox has a private network namespace that
 * forwards only the door's loopback ports, so abstract sockets and host
 * loopback services are out of reach, but an agent can still fetch a URL and
 * still reaches host services bound to non-loopback addresses (the docker
 * bridge 172.17.0.1, br-* addresses, the tailscale IP).
 * Without `pasta` it shares the host namespace and reaches both. Whatever the child's env
 * carries -- a keyed upstream's provider key, say -- stays readable through
 * `/proc/self/environ`. Paths outside the home (`/etc`, `/opt`, another
 * user's world-readable files) stay readable too, as they are to any local
 * process. An agent given a private repository is trusted with its contents.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { DEFAULT_SANDBOX_MASK } from './configKeys.ts'
import { envString, pathSearchPath } from './env.ts'
import { configHome, isUnder, stateDir } from './paths.ts'

/** State-dir segment that holds every agentic HOME. Cache prune names the same segment. */
export const AGENTIC_HOME_DIR = 'agentic-home'

/** Writable bun install tree inside an agentic HOME. Cache prune names the same segment. */
export const SANDBOX_BUN_DIR = 'bun'

/** claude's install cache under the state dir: the tree the unit's BUN_INSTALL names. Cache prune names the same segment. */
export const CLAUDE_INSTALL_DIR = 'bun-install'

/** The directory the sandbox masks: the real home of this process, symlinks resolved, read once. */
const OPERATOR_HOME = realpathSync(homedir())

/**
 * Writable, engined-owned, and never inside a repository -- so the agent keeps
 * its sessions and its downloaded provider packages across launches while the
 * workdir stays read-only. A tmpfs here would work and would re-download the
 * provider on every single call.
 */
export function sandboxHome(agentId: string): string {
  const home = join(stateDir(), AGENTIC_HOME_DIR, agentId)
  mkdirSync(home, { recursive: true })
  return home
}

/** A launch gets no persistent XDG state: only Bun's already-proved install cache is shared. */
export function sandboxLaunchHome(agentId: string): string {
  const parent = sandboxHome(agentId)
  return mkdtempSync(join(parent, 'launch-'))
}

/** A login file an agent keeps under the operator's home, and where the same agent looks for it under a launch home. */
export interface AgentLogin {
  /** Relative to the operator's home. */
  from: string
  /** Relative to the launch home, already accounting for the XDG paths `sandboxEnv` sets. */
  to: string
}

/**
 * Copied, never bound: the agent signs in as the operator without the real
 * file being in its mount table, so nothing it does can rewrite the one the
 * operator's own sessions use. An absent source is a box without that login,
 * and the agent reports "not logged in" itself.
 */
export function copyLogins(
  launchHome: string,
  logins: readonly AgentLogin[],
  operatorHome: string = OPERATOR_HOME,
): void {
  for (const login of logins) {
    const source = resolve(operatorHome, login.from)
    if (!isUnder(operatorHome, source) || source === resolve(operatorHome)) {
      throw new Error(`login ${login.from} is outside the operator home`)
    }
    try {
      if (!isUnder(operatorHome, realpathSync(dirname(source)))) {
        throw new Error(`login ${login.from} is outside the operator home`)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw err
    }
    let fd: number
    try {
      fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        continue
      }
      if (code === 'ELOOP') {
        throw new Error(`login ${login.from} is a symlink, not a regular file`)
      }
      throw err
    }
    try {
      if (!fstatSync(fd).isFile()) {
        throw new Error(`login ${login.from} is not a regular file`)
      }
      const target = resolve(launchHome, login.to)
      if (!isUnder(launchHome, target) || target === resolve(launchHome)) {
        throw new Error(`login ${login.to} is outside the launch home`)
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, readFileSync(fd), { mode: 0o600 })
    } finally {
      closeSync(fd)
    }
  }
}

const GITDIR_POINTER = /^gitdir:\s*(.+)$/m

const WORKTREE_HOME_REL = [join('.cursor', 'worktrees'), join('.claude', 'worktrees')] as const

function resolvedPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** The workdir bind lands after every mask, so a workdir here would re-expose live sockets, host procfs and tmux/X sockets. */
const RUNTIME_ROOTS = ['/proc', '/sys', '/dev', '/run', '/tmp', '/var/tmp'] as const

/**
 * A workdir that is, contains, or sits inside the operator home or a
 * credential path would re-expose that tree through the workdir bind after
 * the home tmpfs. Children of the home that are not themselves sensitive
 * stay allowed -- that is where checkouts live.
 */
export function workdirForbidden(
  workdir: string,
  operatorHome: string = OPERATOR_HOME,
  masks: readonly string[] = DEFAULT_SANDBOX_MASK,
): string | undefined {
  const real = resolvedPath(workdir)
  for (const path of RUNTIME_ROOTS) {
    const root = resolvedPath(path)
    if (isUnder(root, real) || isUnder(real, root)) {
      return `workdir ${workdir} is or sits in a runtime directory (${path})`
    }
  }
  if (isUnder(real, operatorHome)) {
    return `workdir ${workdir} covers the operator home`
  }
  // The workdir bind lands after the mask tmpfs, so a workdir holding a mask root shows every sibling it hides.
  const coveredMask = masks.find((mask) => isUnder(real, resolvedPath(mask)))
  if (coveredMask !== undefined) {
    return `workdir ${workdir} covers the sandbox mask ${coveredMask}`
  }
  // Linked worktrees of the operator's checkouts live here; their parents hold credentials.
  const worktreeRoots = WORKTREE_HOME_REL.map((rel) => resolvedPath(join(operatorHome, rel)))
  if (worktreeRoots.some((root) => real !== root && isUnder(root, real))) {
    return undefined
  }
  // Every dot-directory of the home holds credentials or sessions (gh, docker, kube, browsers); checkouts do not live there.
  const [top = ''] = relative(operatorHome, real).split(sep)
  if (top.startsWith('.') && top !== '..') {
    return `workdir ${workdir} sits in a hidden home directory`
  }
  for (const path of [stateDir(), join(configHome(), 'engined')]) {
    const root = resolvedPath(path)
    if (isUnder(root, real) || isUnder(real, root)) {
      return `workdir ${workdir} covers a sensitive path`
    }
  }
  return undefined
}

function gitdirPointsAtWorkdir(gitDir: string, workdir: string): boolean {
  let named: string
  try {
    named = readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()
  } catch {
    return false
  }
  return named !== '' && resolvedPath(named) === resolvedPath(join(workdir, '.git'))
}

/**
 * Git dirs a launch at `root` needs bound, or `undefined` when `root` has no
 * `.git` so a caller can keep walking. A `.git` directory inside the workdir
 * is already visible, so it adds nothing; one on an ancestor is the repo the
 * subdirectory sits in. A crafted pointer is ignored unless git's own `gitdir`
 * backlink names this root's `.git`. Paths are symlink-resolved, so the path
 * checked is the path bound.
 */
function gitDirsAt(
  root: string,
  operatorHome: string,
  allowGitDirectory: boolean,
): string[] | undefined {
  const gitPath = join(root, '.git')
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(gitPath)
  } catch {
    return undefined
  }
  if (st.isDirectory()) {
    if (!allowGitDirectory) {
      return []
    }
    const real = resolvedPath(gitPath)
    return existsSync(real) && workdirForbidden(real, operatorHome) === undefined ? [real] : []
  }
  let pointer: string
  try {
    pointer = readFileSync(gitPath, 'utf8')
  } catch {
    return []
  }
  const named = GITDIR_POINTER.exec(pointer)?.[1]?.trim()
  if (named === undefined) {
    return []
  }
  const gitDir = resolvedPath(resolve(root, named))
  if (!gitdirPointsAtWorkdir(gitDir, root)) {
    return []
  }
  let commonDir: string | undefined
  try {
    commonDir = resolvedPath(
      resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()),
    )
  } catch {
    // A worktree git dir without commondir is still bound on its own.
  }
  // git writes the git dir as <common>/worktrees/<name>; any other commondir is a forged pointer at a path to expose.
  if (commonDir !== undefined && gitDir !== join(commonDir, 'worktrees', basename(gitDir))) {
    return []
  }
  // A stale pointer would fail bwrap's bind and the whole launch with it;
  // git reporting "not a git repository" is the honest failure instead.
  return [commonDir, gitDir].filter(
    (dir): dir is string =>
      dir !== undefined && existsSync(dir) && workdirForbidden(dir, operatorHome) === undefined,
  )
}

/**
 * A linked worktree names its git dir in a `.git` file, and that dir (plus
 * its shared `commondir`) usually lives outside the workdir, often under the
 * masked home. A workdir inside a checkout has no `.git` of its own: walk
 * ancestors so `git` still finds the repo after the home tmpfs hides it.
 */
export function workdirGitDirs(workdir: string, operatorHome: string = OPERATOR_HOME): string[] {
  const here = gitDirsAt(resolvedPath(workdir), operatorHome, false)
  if (here !== undefined) {
    return here
  }
  let dir = resolvedPath(workdir)
  for (;;) {
    const parent = dirname(dir)
    if (parent === dir) {
      return []
    }
    dir = parent
    const found = gitDirsAt(dir, operatorHome, true)
    if (found !== undefined) {
      return found
    }
  }
}

/**
 * The launch binary's own directory, and its real one when it is a symlink:
 * `bunx` runs `bun` beside it, cursor's launcher runs the `node` beside its
 * target. Binding a masked root or an ancestor of the workdir would undo the
 * tmpfs and show every sibling the mask hid, so those cases name the files
 * instead of the directory.
 */
function binaryShown(binary: string, reexposes: (path: string) => boolean): string[] {
  let real = binary
  try {
    real = realpathSync(binary)
  } catch {
    // A binary that does not exist fails the spawn on its own, naming itself.
  }
  const files = [...new Set([binary, real])]
  return [
    ...new Set(
      [...new Set([dirname(binary), dirname(real)])].flatMap((dir) =>
        reexposes(dir) ? files : [dir],
      ),
    ),
  ]
}

interface SandboxInput {
  /** Absolute `bwrap` path, resolved by the install script the way `bunx` is. */
  bwrap: string
  /** The agent's writable state directory, from `sandboxLaunchHome`. */
  home: string
  /** Bun's persistent install tree, behind a throwaway overlay once its proof seeded it. */
  cache?: string
  /** Only the version-proof launch may seed Bun's install cache. */
  cacheWritable?: boolean
  /** Bound read-only over itself: the one directory the agent was pointed at. */
  workdir: string
  /** tmpfs'd before the workdir bind so siblings of the workdir stay hidden. */
  sandboxMask?: readonly string[]
  /** The launch the sandbox wraps, its binary first. */
  argv: readonly string[]
  /** Files the launch is handed by path (an MCP config, a rendered agent config), bound back read-only. */
  readOnly?: readonly string[]
  /** Further writable binds; only a probe's witness directory, so a hook that fires is seen outside. */
  writable?: readonly string[]
  /** Overrides `OPERATOR_HOME` for a test. */
  operatorHome?: string
  /** Runs the sandbox in a private network namespace; only these loopback ports reach the host. */
  netns?: { pasta: string; ports: readonly number[] }
}

/**
 * `/run` is masked to hide the docker socket and the user bus, but on a
 * systemd-resolved box `/etc/resolv.conf` points into it, and an agent that
 * cannot resolve its provider's host never answers. Only the resolver's own
 * directory comes back.
 */
function resolverDirs(): string[] {
  try {
    const target = realpathSync('/etc/resolv.conf')
    return isUnder('/run', target) ? [dirname(target)] : []
  } catch {
    return []
  }
}

function binds(flag: '--bind' | '--ro-bind', paths: readonly string[]): string[] {
  return paths.flatMap((path) => [flag, path, path])
}

function maskMounts(paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    try {
      return statSync(path).isDirectory() ? ['--tmpfs', path] : []
    } catch {
      return []
    }
  })
}

/**
 * bunx will not start from a read-only install cache: it insists on writing a
 * temporary file beside it first. An overlay gives it that, with every write
 * landing in a tmpfs that dies with the launch, so the proved cache itself
 * stays untouched. Only the version proof binds it through, to seed it.
 */
function cacheMount(cache: string | undefined, writable: boolean): string[] {
  if (cache === undefined) {
    return []
  }
  return writable ? ['--bind', cache, cache] : ['--overlay-src', cache, '--tmp-overlay', cache]
}

/**
 * pasta gives the sandbox a private network namespace with outbound NAT, so
 * the host's abstract unix sockets (X11, dbus) and every loopback-only service
 * are out of reach. `-T` forwards just the door's ports from the namespace's
 * loopback to the host's; `--map-host-loopback none` closes pasta's default
 * mapping of the gateway address onto the host's loopback.
 */
function netnsPrefix(netns: SandboxInput['netns']): string[] {
  if (netns === undefined) {
    return []
  }
  const forward = netns.ports.length === 0 ? [] : ['-T', netns.ports.join(',')]
  return [netns.pasta, '-q', '--config-net', '--map-host-loopback', 'none', ...forward, '--']
}

/** `pasta` for the sandbox's network namespace, or `null` when the box has none. */
export function resolvePasta(): string | null {
  return Bun.which('pasta', { PATH: pathSearchPath() })
}

/** Loopback ports named by the URLs in `values`: what the sandbox's own namespace has to forward to the host. */
export function loopbackPorts(values: readonly (string | undefined)[]): number[] {
  const ports = new Set<number>()
  for (const value of values) {
    try {
      const url = new URL(value ?? '')
      if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        ports.add(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))
      }
    } catch {
      // Not a URL: most env values are not.
    }
  }
  return [...ports]
}

/**
 * Order is the whole mechanism, because a later mount wins. `--ro-bind / /`
 * makes everything read-only; the tmpfs over the operator's home then hides
 * all of it; each bind after that shows one path back through. The agent's
 * home is carved back out read-write, and the workdir is re-bound read-only
 * last -- explicit rather than merely inherited, because the workdir is the
 * one path this floor exists to protect, and it may sit under the home or
 * under a path bound before it.
 *
 * `/tmp` is a tmpfs rather than read-only, because an agent that cannot write a
 * temporary file fails in ways that look like a bug in the agent. `sandboxEnv`
 * points TMPDIR at it. Every tmpfs could mask a workdir mounted underneath
 * it, which is why the workdir comes after all of them.
 */
export function sandboxArgv(input: SandboxInput): string[] {
  const operatorHome = input.operatorHome ?? OPERATOR_HOME
  const [binary = ''] = input.argv
  const masks = input.sandboxMask ?? DEFAULT_SANDBOX_MASK
  // Anything outside the home and the masks is visible through the root bind already, and
  // re-binding it can only fail, on a path like `/bin` that is a symlink.
  const hidden = (path: string): boolean =>
    [operatorHome, ...masks].some((mask) => isUnder(mask, path))
  const maskedRoots = [operatorHome, ...masks].map(resolvedPath)
  const isMaskedRoot = (path: string): boolean => maskedRoots.includes(resolvedPath(path))
  const workdir = resolvedPath(input.workdir)
  const allGitDirs = workdirGitDirs(workdir, operatorHome)
  const gitDirs = allGitDirs.filter(hidden)
  const gitDir = allGitDirs.at(-1)
  const reexposesMasked = (path: string): boolean =>
    isMaskedRoot(path) || (isUnder(path, workdir) && resolvedPath(path) !== workdir)
  const shownBack = [...binaryShown(binary, reexposesMasked), ...(input.readOnly ?? [])].filter(
    (path) => hidden(path) && !reexposesMasked(path),
  )
  return [
    ...netnsPrefix(input.netns),
    ...pinDirs([workdir, ...gitDirs]),
    input.bwrap,
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/var/tmp',
    ...binds('--ro-bind', resolverDirs()),
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-uts',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--tmpfs',
    operatorHome,
    ...maskMounts(masks),
    ...binds('--ro-bind', shownBack),
    ...gitDirs.flatMap((dir, i) => ['--ro-bind-fd', String(PIN_FD_BASE + 1 + i), dir]),
    ...cacheMount(input.cache, input.cacheWritable === true),
    '--bind',
    input.home,
    input.home,
    ...binds('--bind', input.writable ?? []),
    '--ro-bind-fd',
    String(PIN_FD_BASE),
    workdir,
    // The workdir bind is its own mount, so git stops at that boundary instead
    // of walking into an ancestor `.git` even when that dir is visible.
    ...(gitDir === undefined ? [] : ['--setenv', 'GIT_DIR', gitDir]),
    '--chdir',
    workdir,
    // Belt and braces beside defaultAgenticSpawn's process-group kill: if
    // engined dies without getting its signal out, the sandbox still goes.
    '--die-with-parent',
    '--',
    ...input.argv,
  ]
}

const PIN_FD_BASE = 9

/**
 * bwrap resolves a bind source by path, so a parent directory swapped for a
 * symlink after engined's realpath check would bind someone else's tree. This
 * opens each directory once, as the launch's own fd, and refuses unless the fd
 * still names the checked path; bwrap then binds the fd (`--ro-bind-fd`), which
 * no later swap can redirect. Done in the process that runs bwrap because pasta
 * closes every inherited fd, so an fd opened by engined would not reach it.
 */
const PIN_DIRS_SCRIPT = `n=${PIN_FD_BASE}
while [ "$1" != -- ]; do
  eval "exec $n<\\"\\$1\\"" || exit 125
  [ "$(readlink "/proc/self/fd/$n")" = "$1" ] || { echo "engined: $1 changed while launching" >&2; exit 125; }
  n=$((n+1)); shift
done
shift
exec "$@"`

function pinDirs(dirs: readonly string[]): string[] {
  return ['/bin/bash', '-c', PIN_DIRS_SCRIPT, '_', ...dirs, '--']
}

/**
 * Resolved at launch rather than at startup: a box that never runs an
 * agentic engine needs no `bwrap` at all, and making it fatal at boot would
 * take engined down for an engine nobody configured. `null` is refused by the
 * caller -- there is no unsandboxed fallback, because the fallback would be
 * an agent loose in someone's repository and the operator's home.
 */
export function resolveBwrap(): string | null {
  const configured = envString('ENGINED_BWRAP')
  if (configured !== undefined && configured !== '') {
    return configured
  }
  return Bun.which('bwrap', { PATH: pathSearchPath() })
}

/**
 * Everything the agent needs pointed inside its own writable directory. The
 * operator's HOME is masked inside the sandbox, so an agent left pointing at
 * it fails on its own state file rather than on anything to do with the
 * workdir -- and that failure reads like a bug in the agent rather than the
 * floor doing its job.
 */
export function sandboxEnv(
  home: string,
  cache: string = join(home, SANDBOX_BUN_DIR),
): Record<string, string> {
  return {
    HOME: home,
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_STATE_HOME: join(home, 'state'),
    XDG_CACHE_HOME: join(home, 'cache'),
    // The child's environment is an allowlist, so it has no TMPDIR unless one
    // is put there. Without it `bunx` refuses to run at all, with an error
    // about a temporary directory that says nothing about a sandbox, so it is
    // not left to the ambient environment.
    TMPDIR: '/tmp',
    BUN_TMPDIR: '/tmp',
    // Inside the writable home rather than the tmpfs, so a fetched agent
    // package survives to the next launch instead of being downloaded again.
    BUN_INSTALL: cache,
  }
}
