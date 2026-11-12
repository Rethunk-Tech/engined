import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeLaunchHome } from './agenticSandbox.ts'

test('removeLaunchHome removes a home holding a mode-000 subdirectory', () => {
  const home = mkdtempSync(join(tmpdir(), 'launch-home-'))
  mkdirSync(join(home, 'x', 'y'), { recursive: true })
  chmodSync(join(home, 'x'), 0)
  removeLaunchHome(home)
  expect(existsSync(home)).toBe(false)
})
