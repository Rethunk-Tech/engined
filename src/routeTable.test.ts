import { expect, test } from 'bun:test'
import { allowOf, dispatch, exactPath, pathPattern, type Route } from './routeTable.ts'

const routes: Route<[]>[] = [
  { methods: ['GET'], match: exactPath('/a'), handle: () => new Response('get') },
  { methods: ['POST'], match: exactPath('/a'), handle: () => new Response('post') },
  { methods: ['GET'], match: pathPattern(/^\/b\/([^/]+)$/), handle: ([id]) => new Response(id) },
  { methods: ['GET'], match: exactPath('/c'), handle: () => undefined },
]

test('one row set serves a path and names its Allow', async () => {
  expect(await (await dispatch(routes, 'POST', '/a'))?.text()).toBe('post')
  expect(await (await dispatch(routes, 'GET', '/b/x'))?.text()).toBe('x')
  expect(allowOf(routes, '/a')).toEqual(['GET', 'POST'])
  expect(dispatch(routes, 'POST', '/b/x')).toBeUndefined()
  expect(allowOf(routes, '/b/x')).toEqual(['GET'])
  expect(allowOf(routes, '/nope')).toEqual([])
})

test('a handler that declines falls through', () => {
  expect(dispatch(routes, 'GET', '/c')).toBeUndefined()
})
