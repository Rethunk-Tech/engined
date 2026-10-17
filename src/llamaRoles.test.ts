import { expect, test } from 'bun:test'
import { RoleScheduler } from './llamaRoles.ts'

function scheduler(slots: number) {
  const swaps: Array<[string | null, string]> = []
  const s = new RoleScheduler({
    swap: async (from, to) => {
      swaps.push([from, to])
    },
    capacityFor: () => 1,
    pinnedModel: () => undefined,
    slots,
  })
  return { s, swaps }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

test('with one slot, a cold role waits for the busy role, then evicts it', async () => {
  const { s, swaps } = scheduler(1)
  await s.acquire('chat', 'chatM')
  let granted = false
  const embed = s.acquire('embedding', 'embedM').then(() => {
    granted = true
  })
  await settle()
  expect(granted).toBe(false)
  s.release('chat')
  await embed
  expect(swaps).toEqual([
    [null, 'chatM'],
    ['chatM', 'embedM'],
  ])
  expect(s.residentModel('chat')).toBeNull()
})

test('with one slot, an idle resident is evicted and a busy one is never', async () => {
  const { s, swaps } = scheduler(1)
  await s.acquire('chat', 'chatM')
  s.release('chat')
  await s.acquire('embedding', 'embedM')
  expect(swaps[1]).toEqual(['chatM', 'embedM'])
  let granted = false
  const chat = s.acquire('chat', 'chatM').then(() => {
    granted = true
  })
  await settle()
  expect(granted).toBe(false)
  s.release('embedding')
  await chat
  expect(swaps[2]).toEqual(['embedM', 'chatM'])
})
