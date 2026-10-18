import { expect, test } from 'bun:test'
import { CONFIGSVC_URL_PREFIX, configsvcUrlExit, hashPasswordExit } from './configsvcCli.ts'
import { collectLines } from './test-support.ts'

test('--configsvc-url prints the newest logged URL and explains its absence', async () => {
  const out = collectLines()
  const journal = [
    'Oct 17 starting',
    `${CONFIGSVC_URL_PREFIX}http://127.0.0.1:29202/#token=old`,
    'listening',
    `${CONFIGSVC_URL_PREFIX}http://127.0.0.1:29202/#token=new`,
    '',
  ].join('\n')
  expect(await configsvcUrlExit(out.write, async () => ({ stdout: journal, exitCode: 0 }))).toBe(0)
  expect(out.lines).toEqual(['http://127.0.0.1:29202/#token=new'])

  const none = collectLines()
  expect(
    await configsvcUrlExit(
      none.write,
      async () => ({ stdout: '', exitCode: 0 }),
      () => false,
    ),
  ).toBe(1)
  expect(none.lines).toEqual([])
})

test('--hash-password prints an argon2id hash that verifies, and refuses an empty line', async () => {
  const out = collectLines()
  expect(await hashPasswordExit(out.write, async () => 'hunter2\r')).toBe(0)
  expect(out.lines[0]).toStartWith('$argon2id$')
  expect(await Bun.password.verify('hunter2', out.lines[0] as string)).toBe(true)
  expect(await hashPasswordExit(out.write, async () => '')).toBe(1)
})
