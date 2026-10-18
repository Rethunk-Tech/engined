import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderCaddyfile } from './caddyfile.ts'

const TEMPLATE = readFileSync(join(import.meta.dir, '..', 'deploy', 'Caddyfile.cursor'), 'utf8')

test('the config UI site is added only for a bridged name, and the template stays the Cursor door otherwise', () => {
  expect(renderCaddyfile(TEMPLATE, undefined)).toBe(TEMPLATE)
  const out = renderCaddyfile(TEMPLATE, { host: 'engined.lan', port: 29_202, hop: 'hop-secret' })
  expect(out).toContain('https://engined.lan:29444 {')
  expect(out).toContain('reverse_proxy 127.0.0.1:29202 {')
  expect(out).toContain('header_up X-Engined-Hop hop-secret')
  expect(out).toContain('engined.localhost:29443 {')
  expect(out.indexOf('engined.lan')).toBeGreaterThan(out.indexOf('engined.localhost'))
})
