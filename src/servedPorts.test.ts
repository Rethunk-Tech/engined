import { describe, expect, test } from 'bun:test'
import { refuseMovedPorts } from './servedPorts.ts'
import { config } from './test-support.ts'

describe('refuseMovedPorts', () => {
  const served = { listen: 29_200, cursor: 29_201 }

  test('unchanged ports are silent', () => {
    expect(() => refuseMovedPorts(served, config())).not.toThrow()
  })

  test.each([
    [
      'listen_port moved',
      { listen: 29_200 },
      config({ listen_port: 29_210 }),
      /listen_port 29200 -> 29210/,
    ],
    [
      'cursor_port moved once that listener is bound',
      served,
      config({ cursor_port: 29_211 }),
      /cursor_port 29201 -> 29211/,
    ],
    [
      'both ports moved are named together',
      served,
      config({ listen_port: 1, cursor_port: 2 }),
      /listen_port 29200 -> 1, cursor_port 29201 -> 2/,
    ],
  ] as const)('%s', (_name, bound, next, rx) => {
    expect(() => refuseMovedPorts(bound, next)).toThrow(rx)
    expect(() => refuseMovedPorts(bound, next)).toThrow(/kill -s USR1 engined.service/)
  })

  test('an unbound cursor listener may move without a hard reload', () => {
    expect(() =>
      refuseMovedPorts({ listen: 29_200 }, config({ cursor_port: 29_299 })),
    ).not.toThrow()
  })
})
