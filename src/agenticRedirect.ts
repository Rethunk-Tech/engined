/**
 * Pointing an agentic CLI at a provider other than its own: the model id that
 * provider knows the route by, and the environment variables that point the
 * CLI at this launch's keyless upstream route.
 */

import type { HopResult } from './chain.ts'
import type { Exec as SecretExec } from './exec.ts'
import { jsonErrorBody } from './http.ts'
import { decodeAddressSegment, routeForHop, WILDCARD_MODEL } from './routeAddress.ts'
import type { Config, Upstream } from './types.ts'
import { resolveUpstream } from './upstream.ts'

/** A fixed non-secret, so claude has a key to send that the forwarder can strip. */
const KEYLESS_PLACEHOLDER = 'engined-keyless'

/**
 * The child never holds the provider key. Its base URL is this launch's
 * keyless upstream route (`src/launchUpstream.ts`), which strips the
 * placeholder and adds the real credential in whatever header the upstream's
 * `secret` names. claude sends `ANTHROPIC_API_KEY` as `x-api-key`, so the
 * placeholder rides there; `ANTHROPIC_AUTH_TOKEN` is never set.
 *
 * Every model tier is pointed at the same `model`, so nothing silently
 * falls back to an Anthropic-named tier this endpoint does not serve. The
 * telemetry/agent-feature vars are cheap to carry and keep a read-only
 * completion from spawning machinery nobody asked for against a billing
 * account this call was never going to use.
 */
function redirectEnv({
  baseUrl,
  model,
  doorUrl,
}: {
  baseUrl: string
  model: string | undefined
  doorUrl: string
}): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: KEYLESS_PLACEHOLDER,
    // The launch-scoped door: closes the recursion hazard this agent's own
    // network reach into engined otherwise opens. Its own inference goes to
    // `baseUrl`, which reaches only the upstream it was routed to.
    ENGINED_DOOR_URL: doorUrl,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
    CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    ENABLE_TOOL_SEARCH: 'false',
  }
  if (model === undefined) {
    return env
  }
  return { ...env, ...claudeModelEnv(model) }
}

/** Every variable claude reads a model from, so the address segment wins over any tier default. */
export function claudeModelEnv(model: string): Record<string, string> {
  return {
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  }
}

/**
 * The id an upstream actually knows this model by: a route's own
 * `wire_model` when it declared one (an address segment that cannot spell
 * the real id, e.g. an `org/model` slug), else the address segment itself.
 * Shared by the agentic redirect and the remote HTTP proxy: both hand this
 * id straight to someone else's service, where the address a caller dialed
 * would simply 404.
 */
export function resolveUpstreamModelId(
  config: Config,
  engineId: string,
  modelSeg: string,
  upstream?: string,
): string | undefined {
  if (modelSeg === '' || modelSeg === WILDCARD_MODEL) {
    return
  }
  const route = routeForHop(config.routes, engineId, modelSeg, upstream)
  if (route !== undefined) {
    return route.wire_model ?? route.model
  }
  return decodeAddressSegment(modelSeg)
}

type RedirectResolution =
  | { ok: true; env: Record<string, string> }
  | { ok: false; result: HopResult }

/**
 * A failed secret is a 5xx: `runChain` advances past a dead engine rather
 * than failing every consumer of the chain for one unconfigured remote key,
 * and a lone request to just this engine surfaces the fix command directly.
 * The resolved endpoint is thrown away: the forwarder resolves it again per
 * request, and the child only ever gets `keylessBaseUrl`.
 */
interface RedirectOptions {
  upstream: Upstream
  engineId: string
  modelSeg: string
  config: Config
  doorUrl: string
  keylessBaseUrl: string
  secretExec?: SecretExec
}

export async function resolveRedirect({
  upstream,
  engineId,
  modelSeg,
  config,
  doorUrl,
  keylessBaseUrl,
  secretExec,
}: RedirectOptions): Promise<RedirectResolution> {
  const resolved = await resolveUpstream(upstream, secretExec)
  if (!resolved.ok) {
    return {
      ok: false,
      result: { status: resolved.status, body: jsonErrorBody(resolved.status, resolved.error) },
    }
  }
  const model = resolveUpstreamModelId(config, engineId, modelSeg, upstream.id)
  return {
    ok: true,
    env: redirectEnv({ baseUrl: keylessBaseUrl, model, doorUrl }),
  }
}
