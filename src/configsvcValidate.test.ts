import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { checkConfigText } from './configsvcValidate.ts'
import { ENGINES_ROOT, makeTestRoot } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-validate-')

test('the validation copy is owner-only, since the text can carry configsvc.password_hash', () => {
  const configFile = join(fs.mkdtempSync(join(TEST_ROOT, 'check-')), 'config.toml')
  const modes: number[] = []
  const realWrite = fs.writeFileSync
  // The copy is gone once validation returns, so its mode is read the moment it is written.
  const write = spyOn(fs, 'writeFileSync').mockImplementation(((
    ...args: Parameters<typeof fs.writeFileSync>
  ) => {
    realWrite(...args)
    if (typeof args[0] === 'string' && args[0].includes('.validate-')) {
      modes.push(fs.statSync(args[0]).mode & 0o777)
    }
  }) as typeof fs.writeFileSync)
  const umask = process.umask(0o022)
  try {
    checkConfigText('listen_port = 29250\n', {
      configFile,
      enginesRoot: ENGINES_ROOT,
      bunx: 'bunx',
    })
  } finally {
    process.umask(umask)
    write.mockRestore()
  }
  expect(modes).toEqual([0o600])
})
