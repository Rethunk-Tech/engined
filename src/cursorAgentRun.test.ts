import { expect, test } from 'bun:test'
import http2 from 'node:http2'
import { createServer } from 'node:net'
import { framer } from './connectFramer.ts'
import {
  type AgentDeps,
  type ChatMessage,
  type ChatReply,
  serveCursorAgent,
} from './cursorAgent.ts'
import {
  bytesField,
  decode,
  envelope,
  type Field,
  fieldBytes,
  fieldString,
  message,
  stringField,
} from './cursorProto.ts'

const INTERACTION_UPDATE = 1
const TEXT_DELTA = 1
const TURN_ENDED = 14
const EXEC_FROM_SERVER = 2
const EXEC_TO_SERVER = 2

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const addr = probe.address()
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  if (addr === null || typeof addr === 'string') {
    throw new Error('expected a TCP address')
  }
  return addr.port
}

/** `AgentClientMessage` carrying the user's prompt, wrapped as `userText` unwraps it. */
function promptFrame(text: string): Uint8Array {
  const inner = message(stringField(1, text))
  const wrapped = bytesField(1, bytesField(1, inner))
  return message(bytesField(1, message(bytesField(2, wrapped))))
}

const READ_OK = message(bytesField(7, message(bytesField(1, message(stringField(2, 'file body'))))))

interface Seen {
  text: string
  turnEnded: Field[] | undefined
  execs: number
}

/** Drive one Run stream: send the prompt, answer every exec request with a read result, collect what comes back. */
async function runStream(deps: AgentDeps): Promise<Seen> {
  const port = await freePort()
  const server = serveCursorAgent(port, deps)
  const client = http2.connect(`http://127.0.0.1:${port}`)
  try {
    return await new Promise<Seen>((settle, fail) => {
      const timer = setTimeout(() => fail(new Error('stream never ended')), 10_000)
      const seen: Seen = { text: '', turnEnded: undefined, execs: 0 }
      const stream = client.request({
        ':method': 'POST',
        ':path': '/agent.v1.AgentService/Run',
        'content-type': 'application/connect+proto',
      })
      stream.on('error', fail)
      stream.on(
        'data',
        framer((payload) => {
          const fields = decode(payload)
          if (fieldBytes(fields, EXEC_FROM_SERVER) !== undefined) {
            seen.execs += 1
            stream.write(Buffer.from(envelope(message(bytesField(EXEC_TO_SERVER, READ_OK)))))
            return
          }
          const update = fieldBytes(fields, INTERACTION_UPDATE)
          const body = update === undefined ? [] : decode(update)
          const delta = fieldBytes(body, TEXT_DELTA)
          if (delta !== undefined) {
            seen.text += fieldString(decode(delta), 1) ?? ''
          }
          const ended = fieldBytes(body, TURN_ENDED)
          if (ended !== undefined) {
            seen.turnEnded = decode(ended)
          }
        }),
      )
      stream.on('end', () => {
        clearTimeout(timer)
        settle(seen)
      })
      stream.write(Buffer.from(envelope(promptFrame('do the thing'))))
    })
  } finally {
    client.close()
    server.stop()
  }
}

function readCall(id: string): ChatReply['toolCalls'][number] {
  return {
    id,
    type: 'function',
    function: { name: 'read', arguments: JSON.stringify({ path: '/tmp/a' }) },
  }
}

const usageOf = (fields: Field[] | undefined) =>
  [1, 2, 3].map((no) => fields?.find((f) => f.no === no)?.value)

test('a turn streams text, runs a tool round through the CLI, and reports summed usage', async () => {
  const histories: ChatMessage[][] = []
  const replies: ChatReply[] = [
    { text: 'looking', toolCalls: [readCall('c1')], usage: { input: 10, output: 4, cacheRead: 1 } },
    { text: 'done', toolCalls: [], usage: { input: 20, output: 6, cacheRead: 2 } },
  ]
  const seen = await runStream({
    complete: (messages, on) => {
      histories.push(structuredClone(messages))
      const reply = replies[histories.length - 1]
      if (reply === undefined) {
        throw new Error('unexpected extra completion')
      }
      on.text(reply.text)
      return Promise.resolve(reply)
    },
  })

  expect(seen.text).toBe('lookingdone')
  expect(seen.execs).toBe(1)
  expect(histories[0]?.[1]).toEqual({ role: 'user', content: 'do the thing' })
  expect(histories[1]?.at(-1)).toMatchObject({
    role: 'tool',
    tool_call_id: 'c1',
    content: 'file body',
  })
  expect(usageOf(seen.turnEnded)).toEqual([30, 10, 3])
})

test('after MAX_TOOL_ROUNDS the model is told to wrap up and the turn says the budget is spent', async () => {
  const unknownTool = {
    id: 'x',
    type: 'function' as const,
    function: { name: 'nope', arguments: '{}' },
  }
  let calls = 0
  let wrapUp = false
  const seen = await runStream({
    complete: (messages) => {
      calls += 1
      wrapUp ||= messages.some((m) => m.content.includes('tool calls left in this turn'))
      return Promise.resolve({ text: '', toolCalls: [unknownTool] })
    },
  })

  expect(calls).toBe(150)
  expect(wrapUp).toBe(true)
  expect(seen.text).toContain('tool-call budget for this turn is exhausted')
})

test('three consecutive completion failures end the turn with the route error', async () => {
  let calls = 0
  const seen = await runStream({
    complete: () => {
      calls += 1
      return Promise.reject(new Error('engine down'))
    },
  })

  expect(calls).toBe(3)
  expect(seen.text).toContain('chat route failed repeatedly (engine down)')
  expect(seen.turnEnded).toBeDefined()
})
