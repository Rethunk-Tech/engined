import { expect, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { type AgenticSpawn, observeAgentVersion } from './agentic.ts'
import { initTestRoot, newEnginesRoot, redirectStateHome, registry } from './enginesFixtures.ts'
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
