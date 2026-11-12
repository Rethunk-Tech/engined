import { expect, test } from 'bun:test'
import { execRequest, toolCallMessage } from './cursorExec.ts'
import { decode, fieldBytes, fieldString } from './cursorProto.ts'

test('shell exec args send workdir as .', () => {
  const framed = execRequest(1, 'exec-1', 'shell', { command: 'true' })
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
  const framed = toolCallMessage('shell', { command: 'true' }, 'call-1')
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

/** [tool, raw args, execRequest(3, 'exec-1') hex, toolCallMessage(.., 'call-1') hex] captured before the args were read straight from the JSON. */
const WIRE: Array<[string, Record<string, unknown>, string | null, string | null]> = [
  [
    'shell',
    { command: 'ls -la /tmp', description: 'list', background: true },
    '125c08037a06657865632d3112500a0b6c73202d6c61202f746d7012012e18c0a9072206657865632d314228080012200a026c7312050a032d6c6112060a042f746d701a0b6c73202d6c61202f746d7018002000600158017a046c697374',
    '0a480a460a0b6c73202d6c61202f746d7012012e18c0a907220663616c6c2d314228080012200a026c7312050a032d6c6112060a042f746d701a0b6c73202d6c61202f746d7018002000ca030663616c6c2d31',
  ],
  [
    'shell',
    { command: 'true' },
    '123908037a06657865632d31122d0a047472756512012e18c0a9072206657865632d3142140800120c0a04747275651a0474727565180020006001',
    '0a2d0a2b0a047472756512012e18c0a907220663616c6c2d3142140800120c0a04747275651a047472756518002000ca030663616c6c2d31',
  ],
  [
    'read',
    { path: '/a', offset: 5, limit: 10 },
    '121c08037a06657865632d313a100a022f611206657865632d312005280a',
    '42060a040a022f61ca030663616c6c2d31',
  ],
  [
    'write',
    { path: '/a', content: 'hi' },
    '121e08037a06657865632d311a120a022f61120268691a06657865632d312000',
    '62060a040a022f61ca030663616c6c2d31',
  ],
  [
    'delete',
    { path: '/a' },
    '121808037a06657865632d31220c0a022f611206657865632d31',
    '1a060a040a022f61ca030663616c6c2d31',
  ],
  [
    'grep',
    {
      pattern: 'x',
      path: '/p',
      glob: '*.ts',
      output_mode: 'count',
      context: 2,
      context_before: 1,
      context_after: 3,
      case_insensitive: true,
      type: 'py',
      head_limit: 7,
      multiline: true,
      sort: 'path',
      sort_ascending: true,
      offset: 4,
    },
    '124308037a06657865632d312a370a017812022f701a042a2e74732205636f756e7428013003380240014a0270795007580162047061746868017206657865632d31800104',
    '2a090a070a017812022f70ca030663616c6c2d31',
  ],
  [
    'grep',
    { pattern: 'x' },
    '121908037a06657865632d312a0d0a017812007206657865632d31',
    '2a070a050a01781200ca030663616c6c2d31',
  ],
  [
    'ls',
    { path: '/d', ignore: ['a', 'b', 3] },
    '121e08037a06657865632d3142120a022f641201611201621a06657865632d31',
    '6a060a040a022f64ca030663616c6c2d31',
  ],
  ['nope', { path: '/d' }, null, null],
]

test('every tool and option encodes to the same bytes as before', () => {
  for (const [tool, args, exec, rendered] of WIRE) {
    const e = execRequest(3, 'exec-1', tool, args)
    const t = toolCallMessage(tool, args, 'call-1')
    expect(e === undefined ? null : Buffer.from(e).toString('hex')).toBe(exec)
    expect(t === undefined ? null : Buffer.from(t).toString('hex')).toBe(rendered)
  }
})
