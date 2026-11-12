import { expect, test } from 'bun:test'
import { chatModels, handleCursor, isCursorPath } from './cursorDoor.ts'
import { decode, fieldString } from './cursorProto.ts'
import type { DoorContext } from './doorContext.ts'

const route = (model: string | undefined, role: string, disabled?: boolean) => ({
  model,
  role,
  disabled,
})
const ctx = (rows: unknown[]): DoorContext =>
  ({ getConfig: () => ({ routes: rows }) }) as unknown as DoorContext

const table = [
  route('alpha', 'chat'),
  route('beta', 'chat', true),
  route('gamma', 'embed'),
  route(undefined, 'chat'),
  route('delta', 'chat', false),
]

test('only enabled chat routes with a model are offered to the CLI', () => {
  expect(chatModels(ctx(table)).map((r) => r.model)).toEqual(['alpha', 'delta'])
})

test.each([
  ['/aiserver.v1.AiService/Anything', true],
  ['/agent.v1.AgentService/Run', true],
  ['/v1/chat/completions', false],
  ['/engined/v1/engines', false],
])('%s is a cursor path: %p', (path, expected) => {
  expect(isCursorPath(path)).toBe(expected)
})

const bytes = async (path: string, rs: unknown[]) =>
  new Uint8Array(await handleCursor(ctx(rs), path).arrayBuffer())

test('the model list is answered in all three shapes the CLI reads', async () => {
  const available = decode(await bytes('/aiserver.v1.AiService/AvailableModels', table))
  // Two rows (field 2) plus the bare names (field 1), in that order.
  expect(available.map((f) => f.no)).toEqual([2, 2, 1, 1])
  const row = decode(available[0]?.value as Uint8Array)
  expect(fieldString(row, 1)).toBe('alpha')
  expect(row.filter((f) => typeof f.value === 'number').map((f) => f.no)).toEqual([2, 5, 22])

  const usable = decode(await bytes('/aiserver.v1.AiService/GetUsableModels', table))
  expect(usable.map((f) => fieldString(decode(f.value as Uint8Array), 1))).toEqual([
    'alpha',
    'delta',
  ])

  const first = decode(await bytes('/agent.v1.AgentService/GetDefaultModelForCli', table))
  expect(fieldString(decode(first[0]?.value as Uint8Array), 1)).toBe('alpha')
})

test('with no chat route the default model is empty rather than a bad row', async () => {
  expect(await bytes('/agent.v1.AgentService/GetDefaultModelForCli', [])).toHaveLength(0)
  expect(await bytes('/aiserver.v1.AiService/GetUsableModels', [])).toHaveLength(0)
})

test('every other unary call is satisfied by an empty proto message', async () => {
  const res = handleCursor(ctx(table), '/aiserver.v1.AiService/GetPrivacyMode')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/proto')
  expect(new Uint8Array(await res.arrayBuffer())).toHaveLength(0)
})
