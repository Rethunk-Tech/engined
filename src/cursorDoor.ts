/**
 * The unary half of the Cursor protocol: everything cursor-agent asks for
 * before it opens a turn.
 *
 * The CLI boots through a fixed chain of Connect RPCs and only three of them
 * carry anything -- the model list, which it reads from three different
 * messages and will not accept from fewer. The rest are satisfied by an empty
 * message of their own response type.
 *
 * The turn itself is bidirectional and lives in `cursorAgent.ts`; it needs
 * HTTP/2, which this cleartext door does not speak.
 *
 * Schemas are recovered from a pinned cursor-agent bundle.
 */

import { bytesField, intField, message, stringField } from './cursorProto.ts'
import type { DoorContext } from './doorContext.ts'
import { CONTENT_TYPE, STATUS_OK } from './http.ts'
import type { ResolvedRoute } from './types.ts'

const AISERVER_PREFIX = '/aiserver.v1.'
const AGENT_PREFIX = '/agent.v1.'
const PROTO_TYPE = 'application/proto'

export function isCursorPath(pathname: string): boolean {
  return pathname.startsWith(AISERVER_PREFIX) || pathname.startsWith(AGENT_PREFIX)
}

function protoResponse(body: Uint8Array): Response {
  return new Response(body, {
    status: STATUS_OK,
    headers: { [CONTENT_TYPE]: PROTO_TYPE },
  })
}

/** Every enabled chat route on this box. Display name is `route.model`. */
export function chatModels(ctx: DoorContext): ResolvedRoute[] {
  return ctx
    .getConfig()
    .routes.filter((r) => r.role === 'chat' && r.model !== undefined && r.disabled !== true)
}

/**
 * `AvailableModelsResponse`, `GetUsableModelsResponse` and
 * `GetDefaultModelForCliResponse` are three shapes carrying the same list,
 * and the CLI reads all three: answering only the first leaves its picker
 * empty with "Cannot use this model".
 */
function availableModels(models: string[]): Uint8Array {
  const rows = models.map((name) =>
    bytesField(
      2,
      message(
        stringField(1, name),
        intField(2, 1), // default_on
        intField(5, 1), // supports_agent
        intField(22, 1), // supports_plan_mode
      ),
    ),
  )
  return message(...rows, ...models.map((name) => stringField(1, name)))
}

function modelDetails(models: string[]): Uint8Array {
  return message(...models.map((name) => bytesField(1, message(stringField(1, name)))))
}

function defaultModel(models: string[]): Uint8Array {
  const first = models[0]
  return first === undefined ? new Uint8Array() : bytesField(1, message(stringField(1, first)))
}

export async function handleCursor(
  ctx: DoorContext,
  req: Request,
  pathname: string,
): Promise<Response> {
  await req.arrayBuffer()
  const models = chatModels(ctx).flatMap((r) => (r.model === undefined ? [] : [r.model]))
  if (pathname.endsWith('/AvailableModels')) {
    return protoResponse(availableModels(models))
  }
  if (pathname.endsWith('/GetUsableModels')) {
    return protoResponse(modelDetails(models))
  }
  if (pathname.endsWith('ModelForCli')) {
    return protoResponse(defaultModel(models))
  }
  // Identity, marketplaces, plugins, privacy mode, telemetry and server
  // config are all satisfied by an empty message. Server config in
  // particular must NOT ask for HTTP/1.1: that forces the CLI onto a
  // server-streaming fallback which cannot carry tool calls.
  return protoResponse(new Uint8Array())
}
