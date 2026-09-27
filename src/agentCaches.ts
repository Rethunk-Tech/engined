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

function pruneVersionedSiblings(dir: string, cacheRoot: string, keepVersion: string): void {
  if (!isUnder(cacheRoot, dir)) {
    return
  }
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const version = bunCacheVersion(name)
    if (version === undefined || version === keepVersion) {
      continue
    }
    const path = join(dir, name)
    if (!isUnder(cacheRoot, path)) {
      continue
    }
    rmSync(path, { recursive: true, force: true })
  }
}

/**
 * Remove bun-install cache entries for `pkg` at versions other than
 * `keepVersion`. Matches both `pkg@version@@@N` at the package's parent
 * and version children of `pkg/` itself. Hashed `*.npm` blobs and other
 * packages are left alone.
 */
function pruneOtherInstallVersions(
  cacheRoot: string,
  packages: readonly string[],
  keepVersion: string,
): void {
  if (keepVersion === '') {
    return
  }
  for (const pkg of packages) {
    const slash = pkg.lastIndexOf('/')
    const parent = slash === -1 ? cacheRoot : join(cacheRoot, pkg.slice(0, slash))
    const base = slash === -1 ? pkg : pkg.slice(slash + 1)
    if (!isUnder(cacheRoot, parent)) {
      continue
    }
    let names: string[]
    try {
      names = readdirSync(parent)
    } catch {
      continue
    }
    const prefix = `${base}@`
    for (const name of names) {
      const path = join(parent, name)
      if (!isUnder(cacheRoot, path)) {
        continue
      }
      if (name === base) {
        pruneVersionedSiblings(path, cacheRoot, keepVersion)
        continue
      }
      if (!name.startsWith(prefix)) {
        continue
      }
      const version = bunCacheVersion(name.slice(prefix.length))
      if (version === undefined || version === keepVersion) {
        continue
      }
      rmSync(path, { recursive: true, force: true })
    }
  }
}

/**
 * After a pin's floor probe passes, drop other versions of that agent's
 * bun-install cache only. Paths are the literals under `stateDir` (or the
 * given root), never a location read from the environment of a child.
 */
export function pruneAgentInstallCaches(
  agent: string,
  keepVersion: string,
  root: string = stateDir(),
): void {
  if (agent === 'opencode') {
    pruneOtherInstallVersions(
      join(root, ...OPENCODE_INSTALL_CACHE),
      OPENCODE_CACHE_PACKAGES,
      keepVersion,
    )
    return
  }
  if (agent === 'claude') {
    pruneOtherInstallVersions(
      join(root, ...CLAUDE_INSTALL_CACHE),
      CLAUDE_CACHE_PACKAGES,
      keepVersion,
    )
  }
}
