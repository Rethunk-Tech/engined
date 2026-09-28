/**
 * The llama.cpp extras proxy. In router mode, `/tokenize` and
 * `/apply-template` 400 with "model name is missing from the request" unless a
 * model is named — a video-production consumer of these endpoints sends none, so
 * the injection is the entire feature, not a passthrough. The door warms the
 * local chat route before calling here when none is resident.
 *
 * The door addresses these as `/engined/v1/engines/:id/<verb>`; llama-server
 * serves them bare. The caller passes the engine-side path, because forwarding
 * the door's own would ask llama.cpp for a route only this door knows.
 */
import {
  CONTENT_TYPE,
  ENGINE_ERROR_CHARS,
  type HttpClient,
  JSON_CONTENT_TYPE,
  jsonError,
  STATUS_BAD_REQUEST,
  STATUS_UNAVAILABLE,
} from './http.ts'
import { errMessage, parseRecord } from './records.ts'

/** Tokenize/apply-template answers are small; an uncapped read is how a runaway llama-server pins the door. */
const EXTRAS_SUCCESS_CHARS = 1_048_576

/** Throws on a malformed body so the caller answers 400 rather than letting it surface as a 500. */
function injectModel(bodyText: string | undefined, model: string): string {
  if (bodyText === undefined) {
    return JSON.stringify({ model })
  }
  const parsed = parseRecord(bodyText)
  if (parsed === null) {
    throw new SyntaxError('request body must be a JSON object')
  }
  return JSON.stringify(parsed.model === undefined ? { ...parsed, model } : parsed)
}

/** Where the request goes: the engine's own base URL, and its own path for this verb. */
interface ExtrasTarget {
  baseUrl: string
  enginePath: string
  /** Chat-path lease: idle-stop must not fire while this extras call is in flight. */
  hold?: (work: () => Promise<Response>) => Promise<Response>
}

/**
 * Forwards one extras request to the resident llama-server, injecting the
 * resident model where router mode requires one. The body is capped so a
 * runaway llama-server cannot pin the door; an SSE body's `timings` fields
 * still reach the caller unmodified when they fit.
 */
export function proxyExtras(
  req: Request,
  target: ExtrasTarget,
  residentModel: string | null,
  httpClient: HttpClient = fetch,
): Promise<Response> {
  const hold = target.hold ?? ((work: () => Promise<Response>) => work())
  return hold(async () => {
    const url = new URL(req.url)
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    let body = hasBody ? await req.text() : undefined
    if (residentModel !== null && hasBody) {
      try {
        body = injectModel(body, residentModel)
      } catch (err) {
        return jsonError(STATUS_BAD_REQUEST, errMessage(err))
      }
    }

    const upstream = new URL(target.enginePath + url.search, target.baseUrl)
    try {
      const answered = await httpClient(upstream.toString(), {
        method: req.method,
        headers: body === undefined ? undefined : { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
        body,
        signal: req.signal,
      })
      const cap = answered.ok ? EXTRAS_SUCCESS_CHARS : ENGINE_ERROR_CHARS
      const text = (await answered.text()).slice(0, cap)
      return new Response(text, { status: answered.status, headers: answered.headers })
    } catch (err) {
      return jsonError(STATUS_UNAVAILABLE, errMessage(err))
    }
  })
}
