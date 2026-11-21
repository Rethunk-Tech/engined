import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundledBunx, bundledInstallDir } from './paths.ts'

function tree(layout: 'beside' | 'lib'): { exe: string; dir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'engined-paths-'))
  const dir = layout === 'beside' ? root : join(root, 'usr', 'lib', 'engined')
  const exe = layout === 'beside' ? join(root, 'engined') : join(root, 'usr', 'bin', 'engined')
  mkdirSync(join(dir, 'engines'), { recursive: true })
  mkdirSync(join(exe, '..'), { recursive: true })
  writeFileSync(exe, '')
  chmodSync(exe, 0o755)
  writeFileSync(join(dir, 'bunx'), '')
  return { exe, dir, root }
}

test('a binary beside engines/ is its own install tree, through a symlink too', () => {
  const t = tree('beside')
  const link = join(mkdtempSync(join(tmpdir(), 'engined-link-')), 'engined')
  symlinkSync(t.exe, link)
  expect(bundledInstallDir(link)).toBe(t.dir)
  expect(bundledBunx(link)).toBe(join(t.dir, 'bunx'))
  rmSync(t.root, { recursive: true })
})

test('a deb/rpm binary finds ../lib/engined', () => {
  const t = tree('lib')
  expect(bundledInstallDir(t.exe)?.endsWith('/usr/lib/engined')).toBe(true)
  rmSync(t.root, { recursive: true })
})

test('a bun running main.js is not an install tree', () => {
  const t = tree('beside')
  const bun = join(t.root, 'bun')
  writeFileSync(bun, '')
  expect(bundledInstallDir(bun)).toBeUndefined()
  rmSync(t.root, { recursive: true })
})
