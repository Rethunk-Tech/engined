/** Fetch wrappers for the configsvc JSON API. A 401 anywhere returns the app to the sign-in screen. */
import { session } from './store.ts'

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

function messageOf(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null) {
    const error = (body as { error?: { message?: unknown } }).error
    if (typeof error?.message === 'string') {
      return error.message
    }
    const errors = (body as { errors?: { message?: unknown }[] }).errors
    if (typeof errors?.[0]?.message === 'string') {
      return errors[0].message
    }
  }
  return `request failed (${status})`
}

export async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const parsed: unknown = await res.json().catch(() => undefined)
  if (res.status === 401) {
    session.value = 'out'
  }
  if (!res.ok) {
    throw new ApiError(messageOf(parsed, res.status), res.status, parsed)
  }
  return parsed as T
}
