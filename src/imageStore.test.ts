/**
 * The image URL store: id grammar, eviction bounds, and GET of a name this
 * door issued. Substitutes are injected dir/now/keep/ttl, never the operator's
 * state directory.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  evictImages,
  handleStoredImageGet,
  IMAGE_ID_RE,
  IMAGE_TTL_MS,
  storeRenderedImage,
} from './imageStore.ts'

const PIXEL = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

const roots: string[] = []
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
})

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'engined-imagestore-'))
  roots.push(dir)
  mkdirSync(dir, { recursive: true })
  const bounds = { dir: () => dir }
  return bounds
}

describe('IMAGE_ID_RE', () => {
  test('accepts a door-issued id and refuses a traversal', () => {
    expect(IMAGE_ID_RE.test(`${'ab'.repeat(16)}.png`)).toBe(true)
    expect(IMAGE_ID_RE.test('../etc/passwd')).toBe(false)
    expect(IMAGE_ID_RE.test('..%2fetc')).toBe(false)
    expect(IMAGE_ID_RE.test(`${'ab'.repeat(16)}.png/../../x`)).toBe(false)
    expect(IMAGE_ID_RE.test('/etc/passwd')).toBe(false)
    expect(IMAGE_ID_RE.test('')).toBe(false)
  })
})

describe('GET /engined/v1/images/:id', () => {
  test('a stored render is served with the type its suffix names, and a missing or illegal id is 404', async () => {
    const bounds = store()
    const id = storeRenderedImage(PIXEL, 'png', bounds)
    const hit = handleStoredImageGet(id, bounds)
    expect(hit.status).toBe(200)
    expect(hit.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await hit.arrayBuffer())).toEqual(Buffer.from(PIXEL))

    expect(handleStoredImageGet('../etc/passwd', bounds).status).toBe(404)
    expect(
      handleStoredImageGet(id, {
        dir: () => bounds.dir(),
        now: () => Date.now() + IMAGE_TTL_MS + 1,
      }).status,
    ).toBe(404)
  })

  test('a GET never trims the store -- only a write does', () => {
    const bounds = store()
    const first = storeRenderedImage(PIXEL, 'png', bounds)
    const second = storeRenderedImage(PIXEL, 'png', bounds)
    // A cap this tight would evict both on a write; a GET must ignore it,
    // since the whole-store sweep is `storeRenderedImage`'s job alone now.
    const tight = { ...bounds, keep: 1, maxBytes: 1 }
    expect(handleStoredImageGet(second, tight).status).toBe(200)
    expect(handleStoredImageGet(first, bounds).status).toBe(200)
  })
})

describe('eviction', () => {
  test('count cap drops the oldest render', () => {
    const bounds = { ...store(), keep: 1, maxBytes: 1_000_000 }
    const first = storeRenderedImage(PIXEL, 'png', bounds)
    utimesSync(join(bounds.dir(), first), new Date(Date.now() - 2000), new Date(Date.now() - 2000))
    storeRenderedImage(PIXEL, 'png', bounds)
    expect(handleStoredImageGet(first, bounds).status).toBe(404)
  })

  test('byte cap drops the oldest render', () => {
    const bounds = { ...store(), keep: 10, maxBytes: PIXEL.byteLength }
    const first = storeRenderedImage(PIXEL, 'png', bounds)
    utimesSync(join(bounds.dir(), first), new Date(Date.now() - 2000), new Date(Date.now() - 2000))
    storeRenderedImage(PIXEL, 'png', bounds)
    expect(handleStoredImageGet(first, bounds).status).toBe(404)
  })

  test('TTL drops a render that has aged out', () => {
    const bounds = store()
    const id = storeRenderedImage(PIXEL, 'png', bounds)
    evictImages({ ...bounds, now: () => Date.now() + IMAGE_TTL_MS + 1 })
    expect(handleStoredImageGet(id, bounds).status).toBe(404)
  })
})
