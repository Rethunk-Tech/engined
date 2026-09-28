/**
 * Running one hop against an agentic CLI engine: which spec and upstream the
 * hop resolves to, the environment that redirects the CLI at a provider other
 * than its own, the refusals a launch can earn before it starts, and the
 * SSE shape a streaming caller gets back.
 */

import {
  defaultAgenticSpawn,
  launchScopedBaseUrl,
  mintLaunchNonce,
  type RunAgenticResult,
  runAgentic,
} from './agentic.ts'
import { claudeModelEnv, resolveRedirect } from './agenticRedirect.ts'
import type { HopResult } from './chain.ts'
import type { DoorContext } from './doorContext.ts'
import {
  jsonErrorBody,
  SSE_CONTENT_TYPE,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_OK,
  STATUS_UNAVAILABLE,
} from './http.ts'
import { isRecord } from './records.ts'
import { LOCAL_UPSTREAM } from './routeAddress.ts'
import { loadSpec } from './spec.ts'
import type { AgenticSpec } from './specTypes.ts'
import type { EngineEntry, ResolvedRoute } from './types.ts'

/** Splits chat messages across the CLI's prompt and system-prompt channels. */
export function promptsFromMessages(body: Record<string, unknown>): {
  prompt: string
  systemPrompt: string | undefined
} {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const contentFor = (role: string) =>
    messages
      .flatMap((message) =>
        isRecord(message) && message.role === role ? [String(message.content ?? '')] : [],
      )
      .join('\n')
  const systemPrompt = contentFor('system')
  return {
    prompt: messages
      .flatMap((message) =>
        isRecord(message) &&
        (message.role === 'user' || message.role === 'assistant') &&
        String(message.content ?? '') !== ''
          ? [String(message.content ?? '')]
          : [],
      )
      .join('\n'),
    systemPrompt: systemPrompt === '' ? undefined : systemPrompt,
  }
}

/**
 * Whether a field's VALUE demands something no agent CLI has a channel for:
 * `agents.ts`'s whole contract is a prompt string in and answer text out
 * (`parse` yields a `result` string, `delta` an answer fragment), and an
 * agent's own `tools` are engined's read-only floor rather than the
 * caller's. So neither half of a tool loop can cross the boundary in either
 * direction, and dropping such a field silently hands a caller's tool loop
 * prose it will parse as an answer.
 *
 * Both spellings are here: a client sending OpenAI's original
 * `functions`/`function_call` pair asks for exactly what `tools`/
 * `tool_choice` asks for, so covering only the newer names leaves the same
 * tool loop reading prose under a different key.
 *
 * Keyed on the value and not the key, because the values that ask for
 * nothing are exactly what an agent already does: an empty `tools` offers
 * none, `tool_choice: "none"` forbids them outright, `"auto"` permits prose,
 * and `response_format: {type: "text"}` IS prose. Several
 * OpenAI-compatible clients send those unconditionally, and refusing them
 * would refuse traffic that wants nothing.
 *
 * `parallel_tool_calls` is absent: it constrains how tool calls are issued,
 * never that any are, so a body carrying it either also carries a `tools`
 * that demands them or asks for nothing at all.
 */
const AGENTIC_UNHONOURABLE: Record<string, (value: unknown) => boolean> = {
  tools: (v) => !Array.isArray(v) || v.length > 0,
  tool_choice: (v) => v !== 'none' && v !== 'auto',
  functions: (v) => !Array.isArray(v) || v.length > 0,
  function_call: (v) => v !== 'none' && v !== 'auto',
  response_format: (v) => !isRecord(v) || v.type !== 'text',
}

/** The two list-of-tools fields, which a `"none"` choice cancels however long the list is. */
const AGENTIC_TOOL_LISTS = new Set(['tools', 'functions'])

/**
 * Which of those fields this body carries a demanding value for, in the
 * order a caller would read them back. A caller's `null` unsets a wire
 * default (`withoutCallerNulls`) rather than demanding anything.
 *
 * A `"none"` choice is read across fields, not just on its own: it is the
 * caller asking for prose outright, so the tool list it accompanies demands
 * nothing either -- and a client that sends `"none"` is by definition one
 * carrying a list, which is the very shape this refusal exists to let
 * through.
 */
function unhonourableFields(body: Record<string, unknown>): string[] {
  const noneChosen = body.tool_choice === 'none' || body.function_call === 'none'
  return Object.entries(AGENTIC_UNHONOURABLE)
    .filter(([key, demands]) => {
      if (noneChosen && AGENTIC_TOOL_LISTS.has(key)) {
        return false
      }
      const value = body[key]
      return value !== undefined && value !== null && demands(value)
    })
    .map(([key]) => key)
}

let agenticCallSeq = 0

/**
 * The minimal OpenAI chat-completion shape a caller expects back. `usage` is
 * absent rather than zeroed: an agentic CLI reports no token counts, and a
 * fabricated zero reads as a real measurement. A consumer that needs usage
 * needs the CLI to report it first.
 */
function agenticEnvelope(text: string | undefined, research: boolean): Record<string, unknown> {
  agenticCallSeq += 1
  return {
    id: `agentic-${Date.now()}-${agenticCallSeq}`,
    object: 'chat.completion',
    choices: [
      { index: 0, message: { role: 'assistant', content: text ?? '' }, finish_reason: 'stop' },
    ],
    ...(research ? { research: true } : {}),
  }
}

/**
 * An engine has no address of its own -- claude routed at Moonshot is still
 * the engine "claude", loading `engines/claude/spec.toml` exactly like the
 * ambient route does. Only its resolved upstream differs.
 */
function loadAgenticSpec(ctx: DoorContext, engineEntry: EngineEntry) {
  const { enginesRoot, bunx } = ctx.registryOpts
  return loadSpec(engineEntry, { enginesRoot, bunx })
}

function hopError(status: number, message: string): HopResult {
  return { status, body: jsonErrorBody(status, message) }
}

/** `runAgentic`'s outcome, mapped to a hop's result. `version` is carried through either way -- a failed launch still ran a real, pinned process. */
function hopResultFromAgenticOutcome(
  outcome: Awaited<ReturnType<typeof runAgentic>>,
  research: boolean,
): HopResult {
  if (!outcome.ok) {
    return {
      ...hopError(outcome.status, outcome.failure ?? 'agentic call failed'),
      envelopeFailure: outcome.envelopeFailure,
      // An envelope failure's text is the child's own parsed stdout; every
      // other agentic failure here is engined's sentence about the launch.
      bodyCarriesAgentOutput: outcome.envelopeFailure,
      version: outcome.version,
      usage: outcome.usage,
      research: research ? true : undefined,
    }
  }
  return {
    status: outcome.status,
    body: agenticEnvelope(outcome.result, research),
    version: outcome.version,
    usage: outcome.usage,
    research: research ? true : undefined,
  }
}

/** The pin proof, which `runAgentic`'s own workdir-required 400 comes before. `null` means nothing is wrong. */
async function proveAgenticPin(ctx: DoorContext, engineId: string): Promise<HopResult | null> {
  const proof = await ctx.registry.start(engineId)
  if (proof.state === 'installed') {
    return null
  }
  // A plain 503, matching resolveRedirect's own secret-resolution failure: an
  // engine that cannot prove its pin is unavailable, not a proven envelope
  // failure, so a chain skips it (the same rule) rather than treating it as
  // terminal.
  return {
    ...hopError(STATUS_UNAVAILABLE, proof.fix ?? `engine "${engineId}" is not installed`),
    // A probe's fix quotes what the child printed -- its parsed stdout and a
    // tail of its stderr -- so this body answers the caller but stays out of
    // the recorded failure.
    bodyCarriesAgentOutput: true,
  }
}

export interface AgenticHop {
  engineId: string
  modelSeg: string
  route: ResolvedRoute | undefined
  req: {
    rawBody: Record<string, unknown>
    signal: AbortSignal
    setContentType: (ct: string) => void
    toolsHonourableElsewhere: boolean
    inChain: boolean
  }
}

interface RouteRedirectOptions {
  engineId: string
  modelSeg: string
  route: ResolvedRoute | undefined
  doorUrl: string
}

type RouteRedirect =
  | { ok: true; env: Record<string, string> | undefined }
  | { ok: false; result: HopResult }

/**
 * A route naming a real upstream (not ambient, not this box's own `local`)
 * redirects to it: the engine's own launch is identical either way, only
 * its resolved upstream differs. `env: undefined` is the ambient case.
 */
function resolveRouteRedirect(
  ctx: DoorContext,
  { engineId, modelSeg, route, doorUrl }: RouteRedirectOptions,
): RouteRedirect | Promise<RouteRedirect> {
  const upstreamId = route?.upstream ?? null
  if (upstreamId === null || upstreamId === LOCAL_UPSTREAM) {
    return { ok: true, env: undefined }
  }
  const config = ctx.getConfig()
  const upstream = config.upstreams.find((u) => u.id === upstreamId)
  if (upstream === undefined) {
    return {
      ok: false,
      result: hopError(
        STATUS_BAD_GATEWAY,
        `engine "${engineId}" names unknown upstream "${upstreamId}"`,
      ),
    }
  }
  return resolveRedirect({
    upstream,
    engineId,
    modelSeg,
    config,
    doorUrl,
    secretExec: ctx.doorOpts.secretExec,
  })
}

/**
 * Ambient claude has no upstream to redirect to, but the model segment
 * still has to reach the CLI -- otherwise `@/claude/sonnet-5` and
 * `@/claude/opus-4` launch the same process.
 */
function ambientAgentEnv(
  agent: string,
  modelSeg: string,
  route: ResolvedRoute | undefined,
): Record<string, string> | undefined {
  const ambientModel = route?.wire_model ?? route?.model ?? (modelSeg === '' ? undefined : modelSeg)
  return agent === 'claude' && ambientModel !== undefined ? claudeModelEnv(ambientModel) : undefined
}

interface AgenticLaunch {
  spec: AgenticSpec
  /** Already merged: the engine's own table with this route's on top. */
  args: Record<string, unknown>
  agentVersion: string
  doorUrl: string
  /**
   * The model id this agent is told to dial back through the door -- its
   * route's `wire_model` when it declared one, else the address segment.
   * NOT the address a caller used: `@/opencode/code` names the opencode
   * route, and handing that route's own segment back to the child points it
   * at itself, so the name has to resolve to a model on its own. A
   * slash-bearing address cannot be a `model` segment (`config.ts` refuses
   * one), which is exactly why `wire_model` is where it goes.
   */
  dialModel: string
  workdir: string | undefined
  research: boolean
  extraEnv: Record<string, string> | undefined
  req: AgenticHop['req']
  /** Called when the answer is handed off as a stream that outlives the hop; `run` settles when the child exits. */
  onHandoff: (run: Promise<unknown>) => void
}

async function launchAgentic(ctx: DoorContext, launch: AgenticLaunch): Promise<HopResult> {
  const { spec, args, agentVersion, doorUrl, dialModel, workdir, research, extraEnv, req } = launch
  const { rawBody, signal } = req
  const wantsStream = rawBody.stream === true
  const deltas: string[] = []
  let pump: (() => void) | undefined
  let first: (arrived: 'delta' | 'done') => void = () => undefined
  const firstSignal = new Promise<'delta' | 'done'>((resolve) => {
    first = resolve
  })
  const { prompt, systemPrompt } = promptsFromMessages(rawBody)
  const run = runAgentic({
    agent: spec.agent,
    agentVersion,
    // An agent CLI reaches its model back through engined's own door, so an
    // opencode turn is dispatched, chained and accounted for like any other
    // -- always on the launch-scoped URL, never the plain one. An agent with
    // no `configure` (claude) simply never reads this.
    upstream: { baseUrl: doorUrl, model: dialModel },
    args,
    envAllowlist: spec.env,
    workdir,
    prompt,
    systemPrompt,
    research,
    spawn: ctx.doorOpts.agenticSpawn ?? defaultAgenticSpawn,
    bunx: ctx.registryOpts.bunx,
    ambientEnv: ctx.doorOpts.agenticAmbientEnv,
    extraEnv,
    signal,
    onDelta: wantsStream
      ? (text) => {
          deltas.push(text)
          pump?.()
          first('delta')
        }
      : undefined,
  })
  run.then(
    () => first('done'),
    () => first('done'),
  )
  // Commit to a stream only once the CLI has printed answer text: every
  // pre-spawn refusal (400 workdir, floor, secret) and an envelope that
  // fails before its first delta still land as a plain status.
  if (wantsStream && (await firstSignal) === 'delta') {
    launch.onHandoff(run)
    req.setContentType(SSE_CONTENT_TYPE)
    return {
      status: STATUS_OK,
      stream: agenticSse(run, deltas, (p) => {
        pump = p
      }),
      version: agentVersion,
      research: research ? true : undefined,
    }
  }
  return hopResultFromAgenticOutcome(await run, research)
}

type AgenticEntry =
  | { ok: true; engineEntry: EngineEntry; agentVersion: string }
  | { ok: false; result: HopResult }

function agenticRefusal(message: string): AgenticEntry {
  return { ok: false, result: hopError(STATUS_BAD_GATEWAY, message) }
}

/** The engine and the pin it launches at -- or the refusal for one missing either. */
function agenticEntry(ctx: DoorContext, engineId: string): AgenticEntry {
  const engineEntry = ctx.registry.entry(engineId)
  if (!engineEntry) {
    return agenticRefusal(`unknown engine "${engineId}"`)
  }
  const agentVersion = engineEntry.agent_version
  if (agentVersion === undefined) {
    return agenticRefusal(`engine "${engineId}" has no agent_version configured`)
  }
  return { ok: true, engineEntry, agentVersion }
}

/**
 * Only reachable if an engine routed here carries a non-agentic spec, which
 * the kind check upstream already rules out -- but `agent` is what decides the
 * floor, so it is never read off a spec that has not proven it has one.
 */
function agenticSpecOf(ctx: DoorContext, engineEntry: EngineEntry): AgenticSpec | HopResult {
  const { spec } = loadAgenticSpec(ctx, engineEntry)
  if (spec.kind !== 'agentic-cli') {
    return hopError(STATUS_BAD_GATEWAY, `engine "${engineEntry.id}" is not an agentic-cli spec`)
  }
  return spec
}

/**
 * A 502 only while a later hop could still forward these: the refusal is
 * then about this engine's shape rather than the caller's request, the same
 * reason a credential-shaped status advances. With no such hop anywhere in
 * the chain nothing downstream can fix it, so the answer is a terminal 400
 * naming the fields -- which `tools` on the `/openai/v1/models` row also
 * says, discoverable before the first call rather than after it.
 */
function unhonourableRefusal(engineId: string, req: AgenticHop['req']): HopResult | null {
  const unhonourable = unhonourableFields(req.rawBody)
  if (unhonourable.length === 0) {
    return null
  }
  const status = req.toolsHonourableElsewhere ? STATUS_BAD_GATEWAY : STATUS_BAD_REQUEST
  return hopError(
    status,
    `engine "${engineId}" is agentic and cannot honour ${unhonourable.join(', ')} -- an agent CLI answers in prose, never in tool calls`,
  )
}

/**
 * `workdir` is meaningful to an agentic hop and to nothing else, so a caller
 * who addressed a chain had no reason to send one and does not own its
 * absence: there it is this hop's own shape that cannot be satisfied, which
 * advances like any other, and a chain nothing can answer still exhausts to
 * its own 503. A caller who named this engine directly does own the
 * omission and gets `runAgentic`'s terminal 400 naming it, the mistake that
 * is actually theirs, before anything this engine cannot do for them.
 *
 * A field this engine cannot honour is settled first for a chain caller,
 * because `unhonourableRefusal` has already decided it either way -- 502
 * while a later hop can still honour it, terminal 400 when none can. Letting
 * the missing workdir advance ahead of that turns the terminal answer into an
 * exhausted 503 blaming the engine for the one mistake the caller can fix.
 */
async function preLaunchRefusal(
  ctx: DoorContext,
  engineId: string,
  req: AgenticHop['req'],
  workdir: string | undefined,
): Promise<HopResult | null> {
  const refusal = unhonourableRefusal(engineId, req)
  if (refusal !== null && req.inChain) {
    return refusal
  }
  if (workdir === undefined || workdir === '') {
    return req.inChain
      ? hopError(
          STATUS_BAD_GATEWAY,
          `engine "${engineId}" is agentic and this call carried no workdir`,
        )
      : null
  }
  if (refusal !== null) {
    return refusal
  }
  return await proveAgenticPin(ctx, engineId)
}

export function researchMode(
  body: Record<string, unknown>,
): { ok: true; research: boolean } | { ok: false; error: string } {
  const { research } = body
  if (research === undefined) {
    return { ok: true, research: false }
  }
  return typeof research === 'boolean'
    ? { ok: true, research }
    : { ok: false, error: 'research must be a boolean when present' }
}

export async function execAgentic(
  ctx: DoorContext,
  { engineId, modelSeg, route, req }: AgenticHop,
): Promise<HopResult> {
  const config = ctx.getConfig()
  const entry = agenticEntry(ctx, engineId)
  if (!entry.ok) {
    return entry.result
  }
  const { engineEntry, agentVersion } = entry
  const requestedResearch = researchMode(req.rawBody)
  if (!requestedResearch.ok) {
    return hopError(STATUS_BAD_REQUEST, requestedResearch.error)
  }

  // Minted once per launch and revoked the instant this call returns --
  // the only door URL ever handed to this child, and it dies with the
  // process it was handed to. `runAgentic` (inside `launchAgentic`) is what
  // actually spawns; everything between here and the `finally` is still
  // before that, but the nonce is live for the whole window on the same
  // reasoning `resolveRedirect` never caches a secret: cheaper to mint one
  // that goes unused than to widen the window where a real launch could be
  // missing one.
  const nonce = mintLaunchNonce()
  ctx.launchNonces.add(nonce)
  // A streamed launch outlives this call, so its nonce is released when the
  // child exits rather than here.
  let handedOff = false
  try {
    const doorUrl = launchScopedBaseUrl(config.listen_port, nonce)
    const redirect = await resolveRouteRedirect(ctx, { engineId, modelSeg, route, doorUrl })
    if (!redirect.ok) {
      return redirect.result
    }
    // After the redirect, so a misrouted engine is refused for its route first.
    const spec = agenticSpecOf(ctx, engineEntry)
    if (!('agent' in spec)) {
      return spec
    }
    const extraEnv = redirect.env ?? ambientAgentEnv(spec.agent, modelSeg, route)
    const workdir = typeof req.rawBody.workdir === 'string' ? req.rawBody.workdir : undefined
    const blocked = await preLaunchRefusal(ctx, engineId, req, workdir)
    if (blocked !== null) {
      return blocked
    }
    return await launchAgentic(ctx, {
      spec,
      // Route beats engine, the same merge `llama.ts` applies to a
      // container's process flags. Both tables were checked against the
      // read-only floor's forbidden flags at parse, so neither can unsay it
      // here whichever wins a key.
      args: { ...engineEntry.args, ...route?.args },
      agentVersion,
      doorUrl,
      dialModel: route?.wire_model ?? modelSeg,
      workdir,
      research: requestedResearch.research,
      extraEnv,
      req,
      onHandoff: (run) => {
        handedOff = true
        const release = () => ctx.launchNonces.delete(nonce)
        run.then(release, release)
      },
    })
  } finally {
    if (!handedOff) {
      ctx.launchNonces.delete(nonce)
    }
  }
}

/**
 * OpenAI chunk framing for an answer the CLI is still producing: one
 * `chat.completion.chunk` per text delta, a terminal stop chunk, then
 * `[DONE]`. A CLI that fails after its first delta errors the stream, which
 * `chain.ts` records as that attempt's failure rather than a success.
 */
function agenticSse(
  run: Promise<RunAgenticResult>,
  deltas: string[],
  attach: (pump: () => void) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  agenticCallSeq += 1
  const id = `agentic-${Date.now()}-${agenticCallSeq}`
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null,
    extra?: Record<string, unknown>,
  ): Uint8Array =>
    encoder.encode(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...extra,
      })}\n\n`,
    )
  return new ReadableStream({
    start(controller) {
      const pump = (): void => {
        while (deltas.length > 0) {
          controller.enqueue(chunk({ role: 'assistant', content: deltas.shift() }, null))
        }
      }
      attach(pump)
      pump()
      run.then(
        (outcome) => {
          pump()
          if (!outcome.ok) {
            controller.error(new Error(outcome.failure ?? 'agentic call failed'))
            return
          }
          // The answering-route headers went out before this process had
          // even exited, so they could not carry its cost -- this is the
          // first point it is known, and the last chunk of the reply is the
          // only place left to say it.
          const costUsd = outcome.usage?.cost_usd
          controller.enqueue(
            chunk(
              {},
              'stop',
              costUsd === undefined ? undefined : { engined: { cost_usd: costUsd } },
            ),
          )
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
        (err: unknown) => controller.error(err),
      )
    },
  })
}
