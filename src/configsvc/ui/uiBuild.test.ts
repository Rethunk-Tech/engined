import { expect, test } from 'bun:test'
import { bundleReload, moduleBundleChanged } from './uiBuild.ts'

const loaded = ['http://127.0.0.1:4010/index-zf2h7ej9.js']

const shell = (src: string, typeFirst = true) =>
  typeFirst
    ? `<script type="module" crossorigin src="${src}"></script>`
    : `<script src="${src}" type="module"></script>`

test('a different module script reloads; the same script, or none, stays', () => {
  expect(moduleBundleChanged(loaded, shell('../../index-zf2h7ej9.js'))).toBe(false)
  expect(moduleBundleChanged(loaded, shell('../../index-aaaaaaaa.js', false))).toBe(true)
  expect(
    moduleBundleChanged(['http://127.0.0.1:4010/other.js', ...loaded], shell('/index-zf2h7ej9.js')),
  ).toBe(false)
  expect(moduleBundleChanged(loaded, '<script type="module">inline</script>')).toBe(false)
  expect(moduleBundleChanged(loaded, '<script src="../../index-aaaaaaaa.js"></script>')).toBe(false)
  expect(
    moduleBundleChanged(loaded, '<link rel="stylesheet" href="../../index-aaaaaaaa.css">'),
  ).toBe(false)
})

test('a mismatch reloads once, and a match clears the guard', () => {
  expect(bundleReload(true, false)).toEqual({ reload: true, clearGuard: false })
  expect(bundleReload(true, true)).toEqual({ reload: false, clearGuard: false })
  expect(bundleReload(false, true)).toEqual({ reload: false, clearGuard: true })
})
