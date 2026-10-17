import { expect, test } from 'bun:test'
import { takeFrames } from './sse.ts'

test('frames split on blank lines and the unfinished tail is kept', () => {
  const got = takeFrames(
    'event: step\ndata: {"step":1}\n\n: keepalive\n\nevent: exit\ndata: {"exit',
  )
  expect(got.frames).toEqual([{ event: 'step', data: { step: 1 } }])
  expect(got.rest).toBe('event: exit\ndata: {"exit')
})
