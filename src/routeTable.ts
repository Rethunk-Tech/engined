/**
 * One row per served path, so the handler and the `Allow` set of a 405 cannot
 * drift apart: a path is served for exactly the methods its rows name.
 */

export type PathMatch = (pathname: string) => readonly string[] | undefined

export interface Route<A extends unknown[]> {
  methods: readonly string[]
  match: PathMatch
  /** `undefined` falls through to the next row, as a handler that declines the request. */
  handle: (captures: readonly string[], ...args: A) => Response | Promise<Response> | undefined
}

export const GET_HEAD = ['GET', 'HEAD'] as const

export function exactPath(path: string): PathMatch {
  return (pathname) => (pathname === path ? [] : undefined)
}

export function pathPattern(re: RegExp): PathMatch {
  return (pathname) => re.exec(pathname)?.slice(1)
}

export function allowOf<A extends unknown[]>(
  routes: readonly Route<A>[],
  pathname: string,
): string[] {
  const methods = new Set<string>()
  for (const route of routes) {
    if (route.match(pathname) !== undefined) {
      for (const method of route.methods) {
        methods.add(method)
      }
    }
  }
  return [...methods]
}

export function dispatch<A extends unknown[]>(
  routes: readonly Route<A>[],
  method: string,
  pathname: string,
  ...args: A
): Response | Promise<Response> | undefined {
  for (const route of routes) {
    const captures = route.methods.includes(method) ? route.match(pathname) : undefined
    const response = captures === undefined ? undefined : route.handle(captures, ...args)
    if (response !== undefined) {
      return response
    }
  }
  return undefined
}
