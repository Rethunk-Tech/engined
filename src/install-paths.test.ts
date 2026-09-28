import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
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

async function runAssertUnit(
  unitText: string,
  extraEnv: Record<string, string>,
): Promise<{ code: number; err: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'engined-unit-'))
  const unitPath = join(dir, 'u.service')
  writeFileSync(unitPath, unitText)
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[name] = value
    }
  }
  Object.assign(env, extraEnv)
  const proc = Bun.spawn(
    [
      'bash',
      '-c',
      'source "$1"; UNIT_INSTALL_DIR="%h/.local/share/engined"; UNIT_STATE_DIR="%h/.local/state/engined"; assert_unit_names_no_user "$2"',
      'install.sh',
      script,
      unitPath,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const [err, _out, code] = await Promise.all([
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
    proc.exited,
  ])
  return { code, err: err.trimEnd() }
}

test('a rendered unit may contain engined even when that string contains the username', async () => {
  const { code, err } = await runAssertUnit(
    '[Service]\nExecStart=%h/.local/share/engined/main.js\n',
    {},
  )
  expect(err).toBe('')
  expect(code).toBe(0)
})

test('a rendered unit that names the user as a path segment is refused', async () => {
  const user = userInfo().username
  const { code, err } = await runAssertUnit(
    `ReadWritePaths=/home/${user}/.local/share/engined\n`,
    {},
  )
  expect(code).toBe(1)
  expect(err).toContain('names $HOME or the user')
})

test('$HOME in the unit is matched as a literal path, not an ERE', async () => {
  const home = '/tmp/engined-home.with.dots'
  const { code, err } = await runAssertUnit('Description=/tmp/engined-homeXwithXdots\n', {
    HOME: home,
  })
  expect(err).toBe('')
  expect(code).toBe(0)
})
