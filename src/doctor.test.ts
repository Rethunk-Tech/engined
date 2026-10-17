import { expect, test } from 'bun:test'
import { formatDoctor, runDoctor } from './doctor.ts'
import { config, engine } from './test-support.ts'

const OK = { stdout: '27.0.1\n', stderr: '', exitCode: 0 }
const healthy = {
  run: async () => OK,
  exists: () => true,
  which: (cmd: string) => `/usr/bin/${cmd}`,
  agentVersion: async () => ({ ok: true, version: '2026.10' }),
  portFree: async () => true,
  enginedOn: async () => false,
  readable: () => true,
  loadConfig: () => config({ engines: [engine({ id: 'llama', models_dir: '/models' })] }),
}

test('a healthy host passes every check, including per-engine models_dir', async () => {
  const report = await runDoctor(healthy)
  expect(report.ok).toBe(true)
  expect(report.checks.map((c) => c.id)).toContain('models_dir llama')
  expect(report.checks.map((c) => c.id)).toEqual(
    expect.arrayContaining([
      'docker',
      '/dev/kfd',
      'bwrap',
      'agent cursor',
      'keyring',
      'listen_port',
    ]),
  )
})

test('failures name their fix; a held port is fine only when an engined holds it; no config skips the config checks', async () => {
  const sick = await runDoctor({
    ...healthy,
    run: async () => ({ stdout: '', stderr: 'permission denied', exitCode: 1 }),
    exists: (path) => path !== '/dev/kfd',
    which: () => null,
    agentVersion: async () => ({ ok: false, error: 'not found' }),
    portFree: async () => false,
    readable: () => false,
  })
  const failed = sick.checks.filter((c) => !c.ok)
  expect(failed.map((c) => c.id)).toEqual(
    expect.arrayContaining([
      'docker',
      '/dev/kfd',
      'bwrap',
      'agent cursor',
      'keyring',
      'listen_port',
      'models_dir llama',
    ]),
  )
  expect(failed.every((c) => c.fix !== undefined)).toBe(true)
  expect(formatDoctor(sick)).toContain(
    'FAIL docker: docker did not answer: permission denied\n     fix:',
  )

  const held = await runDoctor({
    ...healthy,
    portFree: async () => false,
    enginedOn: async () => true,
  })
  expect(held.checks.find((c) => c.id === 'listen_port')?.ok).toBe(true)

  const noConfig = await runDoctor({
    ...healthy,
    loadConfig: () => {
      throw new Error('cannot read config')
    },
  })
  expect(noConfig.ok).toBe(true)
  expect(noConfig.checks.at(-1)).toMatchObject({ id: 'config', skipped: true })
})
