/**
 * Pointing an agentic CLI at a provider other than its own: the model id that
 * provider knows the route by, and the environment variables that carry the
 * base URL and the key in the shape each CLI expects.
 */

import type { HopResult } from './chain.ts'
import type { Exec as SecretExec } from './exec.ts'
import { jsonErrorBody, STATUS_BAD_GATEWAY } from './http.ts'
import { decodeAddressSegment } from './inventory.ts'
import type { Config, Upstream } from './types.ts'
import { routeForHop, WILDCARD_MODEL } from './types.ts'
import { noBaseUrlFix, resolveUpstreamSecret } from './upstream.ts'

/**
 * `secret.header` is what actually decides which env var carries the key --
 * not a free choice, and not always `ANTHROPIC_API_KEY`. `x-api-key` (Kimi's
 * own coding endpoint's required header) is `ANTHROPIC_API_KEY` verbatim, the
 * CLI's own default. `authorization` (an Anthropic-compatible Bearer gateway,
 * e.g. OpenRouter) is `ANTHROPIC_AUTH_TOKEN` -- and `ANTHROPIC_API_KEY` must
 * still be set, to the EMPTY STRING, because an unset var and an empty one
 * behave differently: unset, the CLI falls back to sending `x-api-key` and
 * the gateway 401s every request. Measured against `~/.local/bin/claude-openrouter`
 * on this box.
 *
 * Every model tier is pointed at the same `model`, so nothing silently
 * falls back to an Anthropic-named tier this endpoint does not serve. The
 * telemetry/agent-feature vars are cheap to carry and keep a read-only
 * completion from spawning machinery nobody asked for against a billing
 * account this call was never going to use.
 */
export function redirectEnv({
  baseUrl,
  secretHeader,
  apiKey,
  model,
  doorUrl,
}: {
  baseUrl: string
  secretHeader: string
  apiKey: string
  model: string | undefined
  doorUrl: string
}): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ...(secretHeader === 'authorization'
      ? { ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_API_KEY: '' }
      : { ANTHROPIC_API_KEY: apiKey }),
    // The launch-scoped door: closes the recursion hazard this agent's own
    // network reach into engined otherwise opens. Carried alongside the
    // real redirect rather than in place of it -- this agent's own
    // inference still goes straight to `baseUrl`, never through here.
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
 * The resolved value only ever reaches the child's environment below --
 * never a log line, an error body, or anything this function returns.
 */
interface RedirectOptions {
  upstream: Upstream
  engineId: string
  modelSeg: string
  config: Config
  doorUrl: string
  secretExec?: SecretExec
}

export async function resolveRedirect({
  upstream,
  engineId,
  modelSeg,
  config,
  doorUrl,
  secretExec,
}: RedirectOptions): Promise<RedirectResolution> {
  const { base_url } = upstream
  if (base_url === undefined) {
    // Config requires a secret alongside a base_url but not the converse, so
    // an address-less upstream reaches here and must refuse rather than hand
    // the child an undefined upstream.
    return {
      ok: false,
      result: { status: STATUS_BAD_GATEWAY, body: jsonErrorBody(noBaseUrlFix(upstream.id)) },
    }
  }
  const resolved = await resolveUpstreamSecret(upstream, secretExec)
  if (!resolved.ok) {
    return { ok: false, result: { status: resolved.status, body: jsonErrorBody(resolved.error) } }
  }
  const model = resolveUpstreamModelId(config, engineId, modelSeg, upstream.id)
  return {
    ok: true,
    env: redirectEnv({
      baseUrl: base_url,
      secretHeader: resolved.header,
      apiKey: resolved.value,
      model,
      doorUrl,
    }),
  }
}
