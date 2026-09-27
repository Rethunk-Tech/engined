/**
 * Reading a caller's JSON body, shared by the door's own verbs and the comfy
 * proxy. It lives apart from both because `src/http.ts` -- where the status
 * and content-type names live -- is upstream of `src/types.ts`, and this
 * needs `parseRecord` from there.
 */

import { jsonError, STATUS_BAD_REQUEST } from './http.ts'
import { parseRecord } from './records.ts'

/**
 * Every JSON body this door reads, or the 400 to return instead. A table is
 * the only accepted shape: `null`, an array and a bare scalar all parse as
 * valid JSON and none of them has the fields a handler goes on to read, so
 * they are rejected here rather than at the first property access. A
 * `Response` back means exactly that; the caller returns it unchanged.
 */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | Response> {
  let raw: string
  try {
    raw = await req.text()
  } catch {
    return jsonError(STATUS_BAD_REQUEST, 'invalid JSON body')
  }
  return parseRecord(raw) ?? jsonError(STATUS_BAD_REQUEST, 'invalid JSON body')
}
