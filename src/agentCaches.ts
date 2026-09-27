import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isUnder, stateDir } from './paths.ts'

/** Bun's install cache names a packed package `name@version@@@N`. */
const BUN_CACHE_VERSION_MARK = '@@@'

const OPENCODE_INSTALL_CACHE = ['agentic-home', 'opencode', 'bun', 'install', 'cache'] as const
const CLAUDE_INSTALL_CACHE = ['bun-install', 'install', 'cache'] as const

/** `opencode-ai` plus the four platform packages bun caches beside it. */
const OPENCODE_CACHE_PACKAGES = [
  'opencode-ai',
  'opencode-linux-x64',
  'opencode-linux-x64-musl',
  'opencode-linux-x64-baseline',
  'opencode-linux-x64-baseline-musl',
] as const

/** `claude-code` plus the glibc and musl linux packages bun caches beside it. */
const CLAUDE_CACHE_PACKAGES = [
  '@anthropic-ai/claude-code',
  '@anthropic-ai/claude-code-linux-x64',
  '@anthropic-ai/claude-code-linux-x64-musl',
] as const

function bunCacheVersion(name: string): string | undefined {
  const mark = name.indexOf(BUN_CACHE_VERSION_MARK)
  return mark === -1 ? undefined : name.slice(0, mark)
}

/**
 * Drop bun-install cache entries under `dir` whose version is not in `keep`.
 * `prefix` is `base@` for packed `base@version@@@N` names, or empty for
 * version children of `base/` itself. The only path check is immediately
 * before unlink.
 */
function pruneVersioned(
  dir: string,
  cacheRoot: string,
  prefix: string,
  keep: ReadonlySet<string>,
): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const base = prefix.endsWith('@') ? prefix.slice(0, -1) : undefined
  for (const name of names) {
    const path = join(dir, name)
    if (base !== undefined && name === base) {
      pruneVersioned(path, cacheRoot, '', keep)
      continue
    }
    if (prefix !== '' && !name.startsWith(prefix)) {
      continue
    }
    const version = bunCacheVersion(prefix === '' ? name : name.slice(prefix.length))
    if (version === undefined || keep.has(version)) {
      continue
    }
    if (!isUnder(cacheRoot, path)) {
      continue
    }
    rmSync(path, { recursive: true, force: true })
  }
}

/**
 * Remove bun-install cache entries for `pkg` at versions other than those
 * in `keep`. Matches both `pkg@version@@@N` at the package's parent and
 * version children of `pkg/` itself. Hashed `*.npm` blobs and other
 * packages are left alone.
 */
function pruneOtherInstallVersions(
  cacheRoot: string,
  packages: readonly string[],
  keep: ReadonlySet<string>,
): void {
  if (keep.size === 0) {
    return
  }
  for (const pkg of packages) {
    const slash = pkg.lastIndexOf('/')
    const parent = slash === -1 ? cacheRoot : join(cacheRoot, pkg.slice(0, slash))
    const base = slash === -1 ? pkg : pkg.slice(slash + 1)
    pruneVersioned(parent, cacheRoot, `${base}@`, keep)
  }
}

/**
 * After a pin's floor probe passes, drop other versions of that agent's
 * bun-install cache only. Paths are the literals under `stateDir` (or the
 * given root), never a location read from the environment of a child.
 * `keep` is the just-proved version plus every `agent_version` the current
 * config pins for engines of this agent.
 */
export function pruneAgentInstallCaches(
  agent: string,
  keep: ReadonlySet<string>,
  root: string = stateDir(),
): void {
  if (agent === 'opencode') {
    pruneOtherInstallVersions(join(root, ...OPENCODE_INSTALL_CACHE), OPENCODE_CACHE_PACKAGES, keep)
    return
  }
  if (agent === 'claude') {
    pruneOtherInstallVersions(join(root, ...CLAUDE_INSTALL_CACHE), CLAUDE_CACHE_PACKAGES, keep)
  }
}
