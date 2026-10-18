// The served shell names a relative module script (`../../index-<hash>.js`); a loaded
// page's script URL is absolute. One fixed base folds both onto the same pathname.
const SCRIPT_BASE = 'https://bundle.invalid/'
const SCRIPT_TAG = /<script\b[^>]*>/gi
const MODULE_TYPE = /\btype\s*=\s*["']module["']/i
const SCRIPT_SRC = /\bsrc\s*=\s*["']([^"']+)["']/i

function scriptPath(url: string): string | undefined {
  if (url === '') {
    return undefined
  }
  try {
    return new URL(url, SCRIPT_BASE).pathname
  } catch {
    return undefined
  }
}

function moduleScriptPaths(html: string): string[] {
  const paths: string[] = []
  for (const tag of html.match(SCRIPT_TAG) ?? []) {
    if (!MODULE_TYPE.test(tag)) {
      continue
    }
    const src = SCRIPT_SRC.exec(tag)?.[1]
    if (src === undefined) {
      continue
    }
    const path = scriptPath(src)
    if (path !== undefined) {
      paths.push(path)
    }
  }
  return paths
}

/** True when the fresh shell names a module script the loaded page does not already have. */
export function moduleBundleChanged(
  currentScriptUrls: readonly string[],
  freshHtml: string,
): boolean {
  const next = moduleScriptPaths(freshHtml)
  if (next.length === 0) {
    return false
  }
  const loaded = new Set<string>()
  for (const url of currentScriptUrls) {
    const path = scriptPath(url)
    if (path !== undefined) {
      loaded.add(path)
    }
  }
  return next.some((path) => !loaded.has(path))
}

/**
 * One automatic reload per tab. A bundle that matches clears the guard so a later
 * build can reload again; a second mismatch in the same tab stays, so a bad comparison cannot loop.
 */
export function bundleReload(
  changed: boolean,
  guardSet: boolean,
): { reload: boolean; clearGuard: boolean } {
  if (!changed) {
    return { reload: false, clearGuard: true }
  }
  if (guardSet) {
    return { reload: false, clearGuard: false }
  }
  return { reload: true, clearGuard: false }
}
