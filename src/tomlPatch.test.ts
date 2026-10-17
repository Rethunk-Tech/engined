import { expect, test } from 'bun:test'
import { parse, patch } from '@decimalturn/toml-patch'

// The vendored build is patched (patches/): without the fix, removing one
// [[route]] drops the [route.args] tables of the entries after it.
test('removing one of three [[route]] entries that each have [route.args] keeps the others intact', () => {
  const entry = (n: number) =>
    `[[route]]\n# route ${n}\nengine = "e${n}"\n\n[route.args]\nngl = ${n}\n\n`
  const src = `listen_port = 29200\n\n${entry(1)}${entry(2)}${entry(3)}`
  const obj = parse(src) as { route: unknown[] }
  obj.route.splice(1, 1)
  expect(patch(src, obj)).toBe(`listen_port = 29200\n\n${entry(1)}${entry(3)}`)
})
