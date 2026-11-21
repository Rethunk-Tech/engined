import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { envString } from './env.ts'

/**
 * All three XDG variables are unset on this box, so the empty case is the
 * normal one rather than the edge — and a naive interpolation resolves to
 * `/engined/…`, which installs the daemon at the filesystem root. A relative
 * value is ignored as the XDG spec requires; honoured, every state path
 * (and the recursive preset removal under it) would follow the cwd.
 */
function xdg(name: string, fallback: string): string {
  const v = envString(name)
  return v !== undefined && isAbsolute(v) ? v : join(homedir(), fallback)
}

/** Exported for `scripts/install.sh`, which renders the systemd user unit under it. */
export function configHome(): string {
  return xdg('XDG_CONFIG_HOME', '.config')
}

export function dataHome(): string {
  return xdg('XDG_DATA_HOME', '.local/share')
}

export function configPath(): string {
  return join(configHome(), 'engined', 'config.toml')
}

/**
 * The install tree a compiled `engined` binary sits in, found from its real
 * path: a release archive (and a Homebrew libexec) keeps `engines/` beside the
 * binary, a deb/rpm keeps it in `../lib/engined`. A bun running `main.js` is not
 * a tree, so only a binary named `engined` is looked at.
 */
export function bundledInstallDir(execPath: string = process.execPath): string | undefined {
  let real: string
  try {
    real = realpathSync(execPath)
  } catch {
    return undefined
  }
  if (basename(real) !== 'engined') {
    return undefined
  }
  const dir = dirname(real)
  return [dir, join(dir, '..', 'lib', 'engined')].find((d) => existsSync(join(d, 'engines')))
}

/** The `bunx` wrapper shipped in the install tree, when there is one. */
export function bundledBunx(execPath: string = process.execPath): string | undefined {
  const dir = bundledInstallDir(execPath)
  return dir !== undefined && existsSync(join(dir, 'bunx')) ? join(dir, 'bunx') : undefined
}

/**
 * Where `main.js` and the `engines/` spec directories live. `ENGINED_INSTALL_DIR`
 * wins (a relative value is ignored, as for the XDG variables), then the tree the
 * running binary sits in; `install.sh` syncs under the data home.
 */
export function installDir(): string {
  const v = envString('ENGINED_INSTALL_DIR')
  return v !== undefined && isAbsolute(v) ? v : (bundledInstallDir() ?? join(dataHome(), 'engined'))
}

/** The one writable path under `ProtectSystem=strict`. */
export function stateDir(): string {
  return join(xdg('XDG_STATE_HOME', '.local/state'), 'engined')
}

/**
 * Cached provider `/models` lists. One directory per upstream id so a
 * catalog never shares a file with another provider's.
 */
export function upstreamInventoryDir(upstreamId: string): string {
  return join(stateDir(), 'upstreams', upstreamId)
}

/** A bind-mount needs the absolute path, not the tilde. */
export function expandTilde(p: string): string {
  if (p === '~') {
    return homedir()
  }
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/**
 * Uploaded voice-clone references. The door names every file in here and
 * hands the caller only an opaque handle, so no caller string ever becomes
 * a path a container reads. Mounted read-only into the TTS engines that
 * clone (each engines/chatterbox-* spec.toml) via the `{state_dir}` placeholder.
 */
export function voicesDir(): string {
  return join(stateDir(), 'voices')
}

/** OpenAI image `response_format: "url"` renders. The door names every file. */
export function imagesDir(): string {
  return join(stateDir(), 'images')
}

/**
 * The llama preset INI: `EngineRegistry` writes it, `LlamaRouter` mounts it,
 * and llama-server reads it once at its own process start. Keyed by engine
 * id so two local llama engines (a second one reusing the llama spec through
 * `spec_dir`) never render into or mount the same file. This is only the
 * default — both take the path as an option and the door hands them the same
 * one, so a test can redirect the pair together and neither writes here.
 */
export function llamaPresetPath(engineId: string): string {
  return `${stateDir()}/llama/${engineId}/preset.ini`
}

/** True when `candidate` is `root` or a path under it. Used so a prune never follows a cache entry out of the directory it was given. */
export function isUnder(root: string, candidate: string): boolean {
  const base = resolve(root)
  const path = resolve(candidate)
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** Renamed into place, so a crash mid-write leaves the old file or none, never a truncated one that parses as empty state. */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}
