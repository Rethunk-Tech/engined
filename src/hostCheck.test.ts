import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { createLlamaDoor, llamaDoorConfig, makeLlamaHttpClient } from './doorFixtures.ts'
import { isAllowedHost } from './hostCheck.ts'
import { makeTestRoot } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-host-')

test('IPs, localhost, this machine and allowlisted names pass; other names do not', () => {
  const allowed = ['box.example.com']
  for (const ok of [
    '127.0.0.1:29200',
    '192.168.1.5',
    '[::1]:29200',
    'localhost:29200',
    'engined.localhost:29443',
    `${hostname()}:29200`,
    `${hostname().split('.')[0]}`,
    'Box.Example.Com:80',
    undefined,
  ]) {
    expect(isAllowedHost(ok, allowed)).toBe(true)
  }
  for (const bad of ['evil.example.net:29200', 'localhost.evil.net', 'box.example.com.evil.net']) {
    expect(isAllowedHost(bad, allowed)).toBe(false)
  }
})

test('a bracketed literal with no closing bracket is refused rather than sliced into an IP', () => {
  // `[::1` sliced from index 1 to indexOf(']') === -1 would be `::`, which
  // `isIP` accepts: a malformed authority must not become a valid literal.
  expect(isAllowedHost('[::1', [])).toBe(false)
  expect(isAllowedHost('[::1]:29200', [])).toBe(true)
})

test('the door refuses a rebound name on GET and serves an IP Host', async () => {
  const { cfg, root } = llamaDoorConfig(TEST_ROOT)
  const door = createLlamaDoor({ ...cfg, allowed_hosts: ['ok.example.com'] }, root, {
    llamaHttpClient: makeLlamaHttpClient([]),
    write: () => undefined,
  })
  const get = (host: string) =>
    door.fetch(new Request('http://engined/openai/v1/models', { headers: { Host: host } }))
  const refused = await get('evil.example.net:29200')
  expect(refused.status).toBe(403)
  expect(await refused.text()).toContain('allowed_hosts')
  expect((await get('127.0.0.1:29200')).status).toBe(200)
  expect((await get('ok.example.com:29200')).status).toBe(200)
})

test('allowed_hosts parses, lowercased, and defaults empty', () => {
  const load = (body: string) => {
    const path = join(TEST_ROOT, 'config.toml')
    writeFileSync(path, `listen_port = 29200\n${body}`)
    return loadConfig(path).allowed_hosts
  }
  expect(load('')).toEqual([])
  expect(load('allowed_hosts = ["Box.Example.com"]\n')).toEqual(['box.example.com'])
})
