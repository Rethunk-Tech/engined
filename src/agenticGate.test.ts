import { expect, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { type AgenticSpawn, observeAgentVersion } from './agentic.ts'
import { AgenticGate } from './agenticGate.ts'
import { initTestRoot, newEnginesRoot, redirectStateHome, registry } from './enginesFixtures.ts'
import type { AgenticSpec } from './specTypes.ts'
import {
  clearVerifiedVersion,
  config,
  engine,
  makeTestRoot,
  writeEngineSpec,
} from './test-support.ts'

initTestRoot('engined-agentic-gate-test-')

const BIN_ROOT = makeTestRoot('engined-cursor-bin-')

test('repeated listings with the cursor binary unchanged spawn --version once', async () => {
  const restoreState = redirectStateHome()
  const id = 'cursor-observe-once'
  clearVerifiedVersion(id)
  const agentPath = join(BIN_ROOT, 'agent')
  writeFileSync(agentPath, '#!/bin/sh\necho 1.0.0\n')
  chmodSync(agentPath, 0o755)
  const root = newEnginesRoot()
  writeEngineSpec(
    root,
    id,
    `
kind = "agentic-cli"
upstream = "optional"
agent = "cursor"
serves = ["/openai/v1/chat/completions"]
command = ["{bunx}", "cursor-agent@{agent_version}", "-p"]
`,
  )
  let spawns = 0
  const exec: AgenticSpawn = () => {
    spawns += 1
    return Promise.resolve({ stdout: '1.0.0\n', stderr: '', exitCode: 0 })
  }
  const prevPath = process.env.PATH
  process.env.PATH = `${BIN_ROOT}${prevPath === undefined ? '' : `:${prevPath}`}`
  try {
    const reg = registry(config({ engines: [engine({ id, agent_version: '1.0.0' })] }), root, {
      observeAgentVersion: (agent, ver) => observeAgentVersion(agent, ver, exec),
      agenticProbeRunner: () => Promise.resolve({ ok: true }),
    })
    await reg.list()
    await reg.list()
    expect(spawns).toBe(1)
  } finally {
    process.env.PATH = prevPath
    clearVerifiedVersion(id)
    restoreState()
  }
})

test('a pin added while the probe runs survives the prune', async () => {
  const restoreState = redirectStateHome()
  const id = 'probe-keep-pin'
  clearVerifiedVersion(id)
  const pinned = engine({ id, agent_version: '1.0.0' })
  const added = engine({ id: 'other-agent', agent_version: '9.9.9' })
  let live = config({ engines: [pinned] })
  const pruneReads: string[] = []
  const spec = {
    kind: 'agentic-cli',
    agent: 'opencode',
    serves: ['/openai/v1/chat/completions'],
    command: ['echo'],
  } as AgenticSpec
  const gate = new AgenticGate({
    runner: () => {
      live = config({ engines: [pinned, added] })
      return Promise.resolve({ ok: true })
    },
    launchNonces: new Set(),
    observeAgentVersion: () => Promise.resolve({ ok: true, version: '1.0.0' }),
    currentConfig: () => {
      for (const row of live.engines) {
        if (row.agent_version !== undefined && row.agent_version !== '') {
          pruneReads.push(row.agent_version)
        }
      }
      return live
    },
  })
  try {
    const status = await gate.status(pinned, spec, true, config({ engines: [pinned] }))
    expect(status.state).toBe('installed')
    expect(pruneReads).toContain('9.9.9')
  } finally {
    clearVerifiedVersion(id)
    restoreState()
  }
})
