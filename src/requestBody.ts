/**
 * Reading a caller's JSON body, shared by the door's own verbs and the comfy
 * proxy. It lives apart from both because `src/http.ts` -- where the status
 * and content-type names live -- is upstream of `src/types.ts`, and this
 * needs `parseRecord` from there.
 */

import { jsonError, STATUS_BAD_REQUEST } from "./http.ts";
import { parseRecord } from "./types.ts";

/** A `Response` back means the body was not a JSON object; the caller returns it unchanged. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | Response> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return jsonError(STATUS_BAD_REQUEST, "invalid JSON body");
  }
  return parseRecord(raw) ?? jsonError(STATUS_BAD_REQUEST, "invalid JSON body");
}
