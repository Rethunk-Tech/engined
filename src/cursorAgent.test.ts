import { expect, test } from 'bun:test'
import { toolRequestFrom } from './cursorAgent.ts'

test('tool arguments of null become an empty table rather than aborting the turn', () => {
  expect(() =>
    toolRequestFrom({
      id: 'call_0',
      type: 'function',
      function: { name: 'read', arguments: 'null' },
    }),
  ).not.toThrow()
  expect(
    toolRequestFrom({
      id: 'call_0',
      type: 'function',
      function: { name: 'read', arguments: 'null' },
    }),
  ).toMatchObject({ tool: 'read' })
})
