import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ObservedVersion } from './agentic.ts'
import type { AgenticProbeRunner } from './agenticProbe.ts'
import type { AgentTarget } from './agents.ts'
import { EngineRegistry } from './engines.ts'
import {
  AGENTIC,
  AGENTIC_NO_VERSION_PLACEHOLDER,
  initTestRoot,
  newEnginesRoot,
  registry,
  specLessProxyEngine,
  TTS_EMPTY_COMMAND,
} from './enginesFixtures.ts'
import { FatalError } from './errors/fatal.ts'
import { stateDir } from './paths.ts'
import type { EngineStatus } from './responses.ts'
import {
  BUNX,
  clearVerifiedVersion,
  config,
  engine,
  route,
  upstream,
  writeEngineSpec,
} from './test-support.ts'
import type { EngineEntry } from './types.ts'

initTestRoot('engined-engines-agentic-test-')

const RX_WIRE_MISMATCH = /wire "openai".*speaks "anthropic"/
const RX_IS_SELF = /is "self"/
/** The launch-scoped dial-back surface: the plain door path plus a live nonce. */
const RX_LAUNCH_SCOPED_DIAL = /^http:\/\/127\.0\.0\.1:39200\/openai\/v1\/[0-9a-f]{32}$/

function trackingRunner(outcome: { ok: boolean; failedProbe?: string }): {
  runner: AgenticProbeRunner
  calls: string[]
} {
  const calls: string[] = []
  const runner: AgenticProbeRunner = (version) => {
    calls.push(version)
    return Promise.resolve(outcome)
  }
  return { runner, calls }
}

describe('spec-less engines: no secret gate, just an optimistic installed', () => {
  test('get() and list() both report installed with no keyring round trip at all', async () => {
    const id = 'spec-less-proxy'
    const reg = registry(config({ engines: [specLessProxyEngine(id)] }), newEnginesRoot())
    expect(reg.get(id)?.state).toBe('installed')
    expect(reg.get(id)).not.toHaveProperty('private_url')
    const listed = (await reg.list()).engines.find((e) => e.id === id)
    expect(listed?.state).toBe('installed')
    expect(listed).not.toHaveProperty('private_url')
  })

  test('a spec-less agentic-cli engine has no built-in launch to fall back to, and refuses at construction', () => {
    expect(
      () =>
        new EngineRegistry(config({ engines: [engine({ id: 'no-spec', kind: 'agentic-cli' })] }), {
          enginesRoot: newEnginesRoot(),
          bunx: BUNX,
        }),
    ).toThrow(FatalError)
  })
})

/**
 * Which shape an engine speaks comes from its agent, and the agent id comes
 * from the spec -- specs load after `loadConfig()`, so a wrong pairing can
 * only be caught here, at registry construction, never as a `config.test.ts`
 * `ParseError`.
 */
describe("an agent's wire is checked against its route's upstream at registry construction", () => {
  test('claude (anthropic) routed at an openai-wire upstream fails at startup, naming both wires', () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'claude', AGENTIC)
    const cfg = config({
      engines: [agenticEngine('claude', '1.0.0')],
      upstreams: [upstream({ id: 'hosted', wire: 'openai', egress: 'remote' })],
      routes: [route({ engine: 'claude', model: 'sonnet', upstream: 'hosted' })],
    })
    expect(() => registry(cfg, root)).toThrow(FatalError)
    expect(() => registry(cfg, root)).toThrow(RX_WIRE_MISMATCH)
  })

  test('claude routed at a matching anthropic-wire upstream constructs clean', () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'claude', AGENTIC)
    const cfg = config({
      engines: [agenticEngine('claude', '1.0.0')],
      upstreams: [upstream({ id: 'hosted', wire: 'anthropic', egress: 'remote' })],
      routes: [route({ engine: 'claude', model: 'sonnet', upstream: 'hosted' })],
    })
    expect(() => registry(cfg, root)).not.toThrow()
  })

  test('an ambient route (no upstream) has nothing to mismatch against', () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'claude', AGENTIC)
    const cfg = config({
      engines: [agenticEngine('claude', '1.0.0')],
      routes: [route({ engine: 'claude', model: 'sonnet', upstream: null })],
    })
    expect(() => registry(cfg, root)).not.toThrow()
  })
})

/**
 * A `self`-trait engine has no LLM-completions wire of its own, so the only
 * upstream it can validly proxy to besides `local` is a peer's own `local`
 * -- never a `wire`-declaring, and therefore always-foreign, provider.
 */
describe('a self-trait engine may proxy to a peer, never to a wire-shaped provider', () => {
  test("a self engine's route naming a wire-declaring upstream fails at startup", () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'voice', TTS_EMPTY_COMMAND)
    const cfg = config({
      engines: [engine({ id: 'voice' })],
      upstreams: [upstream({ id: 'openai', wire: 'openai', egress: 'remote' })],
      routes: [route({ engine: 'voice', model: undefined, upstream: 'openai' })],
    })
    expect(() => registry(cfg, root)).toThrow(FatalError)
    expect(() => registry(cfg, root)).toThrow(RX_IS_SELF)
  })

  test("a self engine's route naming a wire-less peer upstream constructs clean -- bastet kokoro voice1, proxied", () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'voice', TTS_EMPTY_COMMAND)
    const cfg = config({
      engines: [engine({ id: 'voice' })],
      upstreams: [upstream({ id: 'voice1', egress: 'lan' })],
      routes: [route({ engine: 'voice', model: undefined, upstream: 'voice1' })],
    })
    expect(() => registry(cfg, root)).not.toThrow()
  })
})

function agenticEngine(id: string, version: string): EngineEntry {
  return engine({ id, agent_version: version })
}

describe('agentic engines: unproved by default', () => {
  test('no agent_version configured is unavailable, naming the engine', async () => {
    const root = newEnginesRoot()
    writeEngineSpec(root, 'agentic-verify-noversion', AGENTIC_NO_VERSION_PLACEHOLDER)
    const reg = registry(config({ engines: [engine({ id: 'agentic-verify-noversion' })] }), root)
    const listed = (await reg.list()).engines.find((e) => e.id === 'agentic-verify-noversion')
    expect(listed?.state).toBe('unavailable')
    expect(listed?.fix).toContain('agent_version')
  })

  test('an unproved pin with no probe runner injected is unavailable, never installed on faith', async () => {
    const id = 'agentic-verify-unconfigured'
    clearVerifiedVersion(id)
    const root = newEnginesRoot()
    writeEngineSpec(root, id, AGENTIC)
    const reg = registry(config({ engines: [agenticEngine(id, '1.0.0')] }), root)
    const listed = (await reg.list()).engines.find((e) => e.id === id)
    expect(listed?.state).toBe('unavailable')
    expect(listed?.fix).toContain('1.0.0')
  })
})

describe('agentic engines: the verified_version gate', () => {
  test('clearing the recorded version re-verifies: a failing probe stays unavailable, naming the probe and the version -- no real spawn occurs', async () => {
    const id = 'agentic-verify-fail'
    clearVerifiedVersion(id)
    const root = newEnginesRoot()
    writeEngineSpec(root, id, AGENTIC)
    const calls: string[] = []
    const failingRunner: AgenticProbeRunner = (version) => {
      calls.push(version)
      return Promise.resolve({ ok: false, failedProbe: 'byte-identical' })
    }
    const reg = registry(config({ engines: [agenticEngine(id, '2.0.0')] }), root, {
      agenticProbeRunner: failingRunner,
    })

    const listed = (await reg.list()).engines.find((e) => e.id === id)

    expect(calls).toEqual(['2.0.0'])
    expect(listed?.state).toBe('unavailable')
    expect(listed?.fix).toContain('byte-identical')
    expect(listed?.fix).toContain('2.0.0')
    clearVerifiedVersion(id)
  })

  test('both probes passing yields installed, persists the proved version, and a later list skips the runner -- no real spawn occurs', async () => {
    const id = 'agentic-verify-pass'
    clearVerifiedVersion(id)
    const root = newEnginesRoot()
    writeEngineSpec(root, id, AGENTIC)
    const calls: string[] = []
    const passingRunner: AgenticProbeRunner = (version) => {
      calls.push(version)
      return Promise.resolve({ ok: true })
    }
    const reg = registry(config({ engines: [agenticEngine(id, '3.0.0')] }), root, {
      agenticProbeRunner: passingRunner,
    })

    const first = (await reg.list()).engines.find((e) => e.id === id)
    expect(first?.state).toBe('installed')
    expect(calls).toHaveLength(1)

    // A fresh registry against the same state directory sees the proved
    // version and never invokes the runner again -- the pin has not moved.
    const reg2 = registry(config({ engines: [agenticEngine(id, '3.0.0')] }), root, {
      agenticProbeRunner: passingRunner,
    })
    const second = (await reg2.list()).engines.find((e) => e.id === id)
    expect(second?.state).toBe('installed')
    expect(calls).toHaveLength(1)

    clearVerifiedVersion(id)
  })
})

describe("agentic engines: the round-trip probe target follows the route's own egress", () => {
  test('a route naming the local upstream hands the runner a doorUrl+model to dial; an ambient one hands it nothing', async () => {
    const localId = 'agentic-verify-roundtrip-local'
    const ambientId = 'agentic-verify-roundtrip-ambient'
    clearVerifiedVersion(localId)
    clearVerifiedVersion(ambientId)
    const root = newEnginesRoot()
    writeEngineSpec(root, localId, AGENTIC)
    writeEngineSpec(root, ambientId, AGENTIC)
    const calls: Array<AgentTarget | undefined> = []
    const nonces = new Set<string>()
    const liveDuringProbe: boolean[] = []
    const runner: AgenticProbeRunner = (_version, _agent, roundTrip) => {
      calls.push(roundTrip)
      const nonce = roundTrip?.baseUrl.split('/').pop()
      liveDuringProbe.push(nonce !== undefined && nonces.has(nonce))
      return Promise.resolve({ ok: true })
    }
    const cfg = config({
      listen_port: 39_200,
      engines: [agenticEngine(localId, '1.0.0'), agenticEngine(ambientId, '1.0.0')],
      // AGENTIC's fixture agent is "claude" (anthropic wire) regardless of
      // engine id, so "local" needs a matching wire here or registry
      // construction's own wire check refuses the pairing before this
      // test ever reaches the probe it is actually about.
      upstreams: [upstream({ id: 'local', wire: 'anthropic' })],
      routes: [
        route({ engine: localId, model: 'code', upstream: 'local' }),
        route({ engine: ambientId, model: 'sonnet-5', upstream: null }),
      ],
    })
    const reg = registry(cfg, root, { agenticProbeRunner: runner, launchNonces: nonces })

    await reg.list()

    // "code" is only ever the local route's model, so the target below can only be localId's.
    expect(calls).toHaveLength(2)
    const dialed = calls.find((c) => c !== undefined)
    expect(dialed?.model).toBe('code')
    // The launch-scoped surface, not the plain one: a probe spawns a real
    // agent, so what it dials back on is bounded like any other launch.
    expect(dialed?.baseUrl).toMatch(RX_LAUNCH_SCOPED_DIAL)
    // A billed/remote route (claude's ambient shape here) never gets a
    // dial target -- a status poll must never pay for one.
    expect(calls).toContain(undefined)
    // Live for the runner's own window and no longer: registered before the
    // probe is called, gone once it returns.
    expect(liveDuringProbe).toContain(true)
    expect(nonces.size).toBe(0)

    clearVerifiedVersion(localId)
    clearVerifiedVersion(ambientId)
  })
})

/** Always resolves to the given version, real subprocess never touched -- for a hermetic stand-in of a self-updating binary's `--version`. */
function fixedObservedVersion(
  version: string,
): (agent: string, configuredVersion: string) => Promise<{ ok: true; version: string }> {
  return () => Promise.resolve({ ok: true, version })
}

/** A just-cleared agentic pin at "1.0.0" with its spec written, plus a passing probe runner and its call log. */
function freshAgenticPin(id: string): {
  root: string
  passingRunner: AgenticProbeRunner
  calls: string[]
} {
  clearVerifiedVersion(id)
  const root = newEnginesRoot()
  writeEngineSpec(root, id, AGENTIC)
  const { runner: passingRunner, calls } = trackingRunner({ ok: true })
  return { root, passingRunner, calls }
}

/**
 * Proves "1.0.0" for `id` exactly as any ordinary first proof would, then
 * builds a second registry over the same state whose binary now reports
 * "1.0.1" -- readVerifiedVersion still says "1.0.0", so this is a real
 * mismatch -- with whatever probe runner (or none) the caller wires in.
 */
async function proveThenDrift(
  id: string,
  driftRunner: AgenticProbeRunner | undefined,
): Promise<{
  first: EngineStatus | undefined
  drifted: EngineStatus | undefined
  calls: string[]
}> {
  const { root, passingRunner, calls } = freshAgenticPin(id)
  const cfg = config({ engines: [agenticEngine(id, '1.0.0')] })
  const first = registry(cfg, root, {
    agenticProbeRunner: passingRunner,
    observeAgentVersion: fixedObservedVersion('1.0.0'),
  })
  const firstStatus = (await first.list()).engines.find((e) => e.id === id)
  const drifted = registry(cfg, root, {
    ...(driftRunner === undefined ? {} : { agenticProbeRunner: driftRunner }),
    observeAgentVersion: fixedObservedVersion('1.0.1'),
  })
  const driftedStatus = (await drifted.list()).engines.find((e) => e.id === id)
  return { first: firstStatus, drifted: driftedStatus, calls }
}

describe('agentic engines: the observed-version gate (a self-updating binary drifting from its proof)', () => {
  test('a proved version, then a simulated drift with no probe runner, flips the engine unavailable and the fix names both versions', async () => {
    const id = 'agentic-verify-drift-noRunner'
    // With no probe runner to re-prove it, engined must refuse to serve
    // rather than trust a floor that was never actually checked for this binary.
    const { first, drifted } = await proveThenDrift(id, undefined)
    expect(first?.state).toBe('installed')
    expect(drifted?.state).toBe('unavailable')
    expect(drifted?.fix).toContain('1.0.0')
    expect(drifted?.fix).toContain('1.0.1')
    clearVerifiedVersion(id)
  })

  test('a proved version, then a simulated drift with a probe runner that fails, stays unavailable and names both versions and the failed probe', async () => {
    const id = 'agentic-verify-drift-failRunner'
    const { runner: failingRunner } = trackingRunner({ ok: false, failedProbe: 'byte-identical' })
    const { drifted } = await proveThenDrift(id, failingRunner)
    expect(drifted?.state).toBe('unavailable')
    expect(drifted?.fix).toContain('1.0.0')
    expect(drifted?.fix).toContain('1.0.1')
    expect(drifted?.fix).toContain('byte-identical')
    clearVerifiedVersion(id)
  })

  test('a proved version, then a simulated drift with a probe runner that passes, re-proves and persists the NEW observed version, not the configured pin', async () => {
    const id = 'agentic-verify-drift-reproves'
    const { runner: passingRunner, calls: reproveCalls } = trackingRunner({ ok: true })
    const { drifted, calls } = await proveThenDrift(id, passingRunner)
    expect(drifted?.state).toBe('installed')
    expect(calls).toEqual(['1.0.0'])
    expect(reproveCalls).toEqual(['1.0.1'])
    const recorded = readFileSync(join(stateDir(), 'agentic', id, 'verified_version'), 'utf8')
    expect(recorded.trim()).toBe('1.0.1')
    clearVerifiedVersion(id)
  })

  test('a binary that cannot be resolved at all is unavailable, names the reason, and never calls the probe runner', async () => {
    const id = 'agentic-verify-unresolved-binary'
    const { root, passingRunner, calls } = freshAgenticPin(id)
    const reg = registry(config({ engines: [agenticEngine(id, '1.0.0')] }), root, {
      agenticProbeRunner: passingRunner,
      observeAgentVersion: () =>
        Promise.resolve({ ok: false, error: 'cursor\'s "agent" binary was not found on PATH' }),
    })
    const status = (await reg.list()).engines.find((e) => e.id === id)
    expect(status?.state).toBe('unavailable')
    expect(status?.fix).toContain('not found on PATH')
    expect(calls).toHaveLength(0)
    clearVerifiedVersion(id)
  })
})

/** A registry over one just-cleared agentic pin, wired to a tracking probe runner with the given outcome. */
function setupAgenticVerify(
  id: string,
  version: string,
  outcome: { ok: boolean; failedProbe?: string },
): { reg: EngineRegistry; calls: string[] } {
  clearVerifiedVersion(id)
  const root = newEnginesRoot()
  writeEngineSpec(root, id, AGENTIC)
  const { runner, calls } = trackingRunner(outcome)
  const reg = registry(config({ engines: [agenticEngine(id, version)] }), root, {
    agenticProbeRunner: runner,
  })
  return { reg, calls }
}

describe('agentic engines: a failed probe is cached, not retried, until the pin changes', () => {
  test('a failing pin is probed once; a later list on the same pin skips the runner', async () => {
    const id = 'agentic-verify-fail-cached'
    const { reg, calls } = setupAgenticVerify(id, '1.0.0', {
      ok: false,
      failedProbe: 'byte-identical',
    })

    const first = (await reg.list()).engines.find((e) => e.id === id)
    expect(first?.state).toBe('unavailable')
    expect(calls).toHaveLength(1)

    const second = (await reg.list()).engines.find((e) => e.id === id)
    expect(second?.state).toBe('unavailable')
    expect(calls).toHaveLength(1)

    clearVerifiedVersion(id)
  })

  test('bumping the pin after a failure re-arms the probe', async () => {
    const id = 'agentic-verify-fail-rearm'
    const { reg, calls } = setupAgenticVerify(id, '1.0.0', {
      ok: false,
      failedProbe: 'byte-identical',
    })

    await reg.list()
    expect(calls).toHaveLength(1)

    reg.reload(config({ engines: [agenticEngine(id, '1.0.1')] }))
    await reg.list()
    expect(calls).toHaveLength(2)

    clearVerifiedVersion(id)
  })

  test('two concurrent polls on the same unproved pin share one in-flight probe', async () => {
    const id = 'agentic-verify-concurrent'
    const { reg, calls } = setupAgenticVerify(id, '1.0.0', { ok: true })

    const [a, b] = await Promise.all([reg.list(), reg.list()])
    expect(a.engines.find((e) => e.id === id)?.state).toBe('installed')
    expect(b.engines.find((e) => e.id === id)?.state).toBe('installed')
    expect(calls).toHaveLength(1)

    clearVerifiedVersion(id)
  })
})

/** The version the door has actually proved for an agentic engine, as recorded on disk. */
function provedVersion(id: string): string {
  return readFileSync(join(stateDir(), 'agentic', id, 'verified_version'), 'utf8').trim()
}

/** A registry over one just-cleared agentic pin whose version observation is the caller's own. */
function setupAgenticObserve(
  id: string,
  observeAgentVersion: () => Promise<ObservedVersion>,
): EngineRegistry {
  clearVerifiedVersion(id)
  const root = newEnginesRoot()
  writeEngineSpec(root, id, AGENTIC)
  return registry(config({ engines: [agenticEngine(id, '1.0.0')] }), root, {
    agenticProbeRunner: trackingRunner({ ok: true }).runner,
    observeAgentVersion,
  })
}

describe('a listing never blocks on the version observation; a launch always does', () => {
  test('the listing answers from the last observation and refreshes behind itself; start() re-observes', async () => {
    const id = 'agentic-observe-off-listing'
    const observations: string[] = []
    let observed = '1.0.0'
    const reg = setupAgenticObserve(id, () => {
      observations.push(observed)
      return Promise.resolve({ ok: true, version: observed })
    })

    // The first listing has nothing to answer from and pays the observation.
    await reg.list()
    expect(observations).toEqual(['1.0.0'])
    expect(provedVersion(id)).toBe('1.0.0')

    // A self-update the door has not observed yet: the listing answers from
    // the version it knows rather than waiting, so the proof on file is still
    // the old one even though the refresh it kicked has seen the new one.
    observed = '1.0.1'
    await reg.list()
    expect(provedVersion(id)).toBe('1.0.0')

    // A launch is the proof point and re-observes, so what it proves is what
    // the binary reports at that moment -- never what a poll cached earlier.
    observed = '1.0.2'
    await reg.start(id)
    expect(provedVersion(id)).toBe('1.0.2')

    clearVerifiedVersion(id)
  })

  test('a stalled observation blocks neither a listing nor a second poll, and only one is in flight', async () => {
    const id = 'agentic-observe-stalled'
    let spawns = 0
    let release: (() => void) | undefined
    const reg = setupAgenticObserve(id, () => {
      spawns += 1
      return spawns === 1
        ? Promise.resolve({ ok: true, version: '1.0.0' })
        : new Promise((resolve) => {
            release = () => resolve({ ok: true, version: '1.0.0' })
          })
    })

    await reg.list()
    expect(spawns).toBe(1)

    // Both polls answer while the refresh the first one kicked is still stuck.
    const stalled = (await reg.list()).engines.find((e) => e.id === id)
    expect(stalled?.state).toBe('installed')
    expect((await reg.list()).engines.find((e) => e.id === id)?.state).toBe('installed')
    expect(spawns).toBe(2)

    release?.()
    clearVerifiedVersion(id)
  })
})
