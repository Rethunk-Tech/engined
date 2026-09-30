import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
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

/** Where the install script syncs `main.js` and the `engines/` spec directories. */
export function installDir(): string {
  return join(dataHome(), 'engined')
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
  return path === base || path.startsWith(base + sep)
}
