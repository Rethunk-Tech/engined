import { expect, test } from 'bun:test'
import { join } from 'node:path'
import process from 'node:process'
import { configHome, installDir, stateDir } from './paths.ts'

const script = join(import.meta.dir, '..', 'scripts', 'install.sh')
const XDG = 'XDG_DATA_HOME'

/**
 * install.sh's own answer: the script is sourced, so this is the resolution a
 * real install gets rather than a re-derivation of it.
 */
async function runInstallScript(
  dataHome: string | undefined,
): Promise<{ code: number; out: string; err: string }> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== XDG) {
      env[name] = value
    }
  }
  if (dataHome !== undefined) {
    env[XDG] = dataHome
  }

  const proc = Bun.spawn(
    [
      'bash',
      '-c',
      'source "$1"; resolve_paths; printf \'%s\\n\' "$INSTALL_DIR" "$STATE_DIR" "$UNIT_DIR"',
      'install.sh',
      script,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out: out.trimEnd(), err: err.trimEnd() }
}

function fromPathsModule(dataHome: string | undefined): string[] {
  // Assigning `undefined` to a process.env key stores the string "undefined";
  // only removing the key reproduces the unset case paths.ts branches on.
  const previous = process.env[XDG]
  if (dataHome === undefined) {
    delete process.env[XDG]
  } else {
    process.env[XDG] = dataHome
  }
  try {
    return [installDir(), stateDir(), join(configHome(), 'systemd', 'user')]
  } finally {
    if (previous === undefined) {
      delete process.env[XDG]
    } else {
      process.env[XDG] = previous
    }
  }
}

test.each([
  ['unset', undefined],
  ['set', '/tmp/engined-xdg-data'],
])('install.sh installs where src/paths.ts says, XDG_DATA_HOME %s', async (_label, dataHome) => {
  const { code, out, err } = await runInstallScript(dataHome)
  expect(err).toBe('')
  expect(code).toBe(0)
  expect(out.split('\n')).toEqual(fromPathsModule(dataHome))
})

test('install.sh refuses a resolution too shallow to install into', async () => {
  const { code, err } = await runInstallScript('/')
  expect(code).toBe(1)
  expect(err).toContain('too shallow to install into')
})
