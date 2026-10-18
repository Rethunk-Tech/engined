import { expect, test } from 'bun:test'
import { clipboardFlash } from './clipboard.ts'

test('clipboardFlash flashes Copied on success and Copy failed on refusal', async () => {
  expect(await clipboardFlash('ok', async () => undefined)).toBe('Copied')
  expect(
    await clipboardFlash('no', async () => {
      throw new Error('denied')
    }),
  ).toBe('Copy failed')
})
