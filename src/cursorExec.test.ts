import { expect, test } from 'bun:test'
import { execRequest, toolCallMessage } from './cursorExec.ts'
import { decode, fieldBytes, fieldString } from './cursorProto.ts'

test('shell exec args send workdir as .', () => {
  const framed = execRequest(1, 'exec-1', { tool: 'shell', command: 'true' })
  expect(framed).toBeDefined()
  if (framed === undefined) {
    return
  }
  const inner = fieldBytes(decode(framed), 2)
  expect(inner).toBeDefined()
  if (inner === undefined) {
    return
  }
  const args = fieldBytes(decode(inner), 2)
  expect(args).toBeDefined()
  if (args === undefined) {
    return
  }
  expect(fieldString(decode(args), 1)).toBe('true')
  expect(fieldString(decode(args), 2)).toBe('.')
})

test('shell tool-call args send workdir as .', () => {
  const framed = toolCallMessage({ tool: 'shell', command: 'true' }, 'call-1')
  expect(framed).toBeDefined()
  if (framed === undefined) {
    return
  }
  const wrap = fieldBytes(decode(framed), 1)
  expect(wrap).toBeDefined()
  if (wrap === undefined) {
    return
  }
  const args = fieldBytes(decode(wrap), 1)
  expect(args).toBeDefined()
  if (args === undefined) {
    return
  }
  expect(fieldString(decode(args), 2)).toBe('.')
})
