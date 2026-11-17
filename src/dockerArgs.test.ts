/**
 * `dockerArgs.ts` on the argv it actually produces: a spec value is one argv
 * element, never something docker can split into a second flag, and the fields
 * a spec may leave empty add nothing at all.
 */
import { describe, expect, test } from 'bun:test'
import {
  buildRunArgs,
  hostBindings,
  hostPathFor,
  mountSpec,
  networkName,
  parseExposedPort,
  proxyName,
  proxyRunArgs,
  SPEC_LABEL,
  specDigest,
} from './dockerArgs.ts'
import { assignEnv, clearEnv } from './env.ts'
import type { RunnableContainerSpec } from './specTypes.ts'
import type { Volume } from './types.ts'

const SPEC: RunnableContainerSpec = {
  kind: 'openai-http',
  serves: ['chat'],
  env: [],
  command: [],
  upstream: 'self',
  image: 'x:1',
  obtain: 'pull',
  devices: [],
  group_add: [],
  security_opt: [],
  init: false,
  streaming: false,
  volumes: [],
  artifacts: [],
  ready: { path: '/health', status: 200 },
}

describe('mountSpec', () => {
  test('a read-write mount carries no suffix, and :ro is the only extra field', () => {
    expect(mountSpec({ name: '/host/models', path: '/models' })).toBe('/host/models:/models')
    expect(mountSpec({ name: '/host/models', path: '/models', read_only: false })).toBe(
      '/host/models:/models',
    )
    expect(mountSpec({ name: '/host/models', path: '/models', read_only: true })).toBe(
      '/host/models:/models:ro',
    )
  })
})

describe('hostPathFor', () => {
  const bind: Volume = { name: '/data/whisper', path: '/models' }

  test('an artifact at the mount root resolves to the host directory itself', () => {
    expect(hostPathFor({ path: '/models', obtain: '' }, [bind])).toBe('/data/whisper')
  })

  test('an artifact nested under the mount joins the remainder onto the host path', () => {
    expect(hostPathFor({ path: '/models/sub/x.gguf', obtain: '' }, [bind])).toBe(
      '/data/whisper/sub/x.gguf',
    )
  })

  test('a mount path with a trailing slash still matches its children, and not a sibling prefix', () => {
    const slashed: Volume = { name: '/data/m', path: '/models/' }
    expect(hostPathFor({ path: '/models/x.bin', obtain: '' }, [slashed])).toBe('/data/m/x.bin')
    // `/models2/x` is not under `/models`.
    expect(hostPathFor({ path: '/models2/x', obtain: '' }, [slashed])).toBeNull()
    expect(hostPathFor({ path: '/models2/x', obtain: '' }, [bind])).toBeNull()
  })

  test('a named volume is never host-visible, even when a later bind mount would cover the path', () => {
    expect(hostPathFor({ path: '/models/x.bin', obtain: '' }, [bind])).toBe('/data/whisper/x.bin')
    expect(
      hostPathFor({ path: '/models/x.bin', obtain: '' }, [
        { name: 'named', path: '/models' },
        bind,
      ]),
    ).toBe('/data/whisper/x.bin')
  })
})

describe('parseExposedPort', () => {
  test('a port key written without a protocol still reads as its number', () => {
    const inspect = JSON.stringify([{ Config: { ExposedPorts: { '8006': {} } } }])
    expect(parseExposedPort(inspect, 'x:1')).toEqual({ port: 8006 })
  })

  test('an inspect body with no Config table is "no ports" rather than a throw', () => {
    expect(parseExposedPort(JSON.stringify([{}]), 'x:1')).toEqual({
      error: 'x:1 exposes no ports',
    })
    expect(parseExposedPort(JSON.stringify({ Config: {} }), 'x:1')).toEqual({
      error: 'x:1 exposes no ports',
    })
  })
})

describe('hostBindings', () => {
  test('each published mapping is reduced to its host side, and the IPv6 line kept as written', () => {
    expect(hostBindings('127.0.0.1:33103->8006/tcp, [::]:33103->8006/tcp')).toBe(
      '127.0.0.1:33103\n[::]:33103',
    )
  })

  test('a container with no published port yields an empty string', () => {
    expect(hostBindings('')).toBe('')
    expect(hostBindings('8006/tcp')).toBe('8006/tcp')
  })
})

describe('names', () => {
  test('the proxy and the network are derived from the container name, never configured', () => {
    expect(proxyName('engined-x')).toBe('engined-x.proxy')
    expect(networkName('engined-x')).toBe('engined-x.net')
  })
})

describe('buildRunArgs', () => {
  test('a spec value with spaces or a leading dash stays one argv element', () => {
    const hostile: RunnableContainerSpec = {
      ...SPEC,
      volumes: [{ name: '/host/my models', path: '/models' }],
      devices: ['/dev/dri', '--privileged'],
      group_add: ['--volume=/:/host'],
      entrypoint: ['/bin/sh -c', '-c'],
      command: ['--flag with space', '; rm -rf /'],
    }
    const argv = buildRunArgs('engined-x', hostile)

    expect(argv).toContain('/host/my models:/models')
    expect(argv).toContain('--volume=/:/host')
    expect(argv).toContain('/bin/sh -c')
    expect(argv).toContain('; rm -rf /')
    // Nothing was split: every value is exactly one element, so docker sees no
    // new flag and no shell ever parses the string.
    expect(argv.some((arg) => arg.includes(' '))).toBe(true)
    expect(argv.filter((arg) => arg === '--volumes')).toEqual([])
    // The entrypoint's remaining words and the command follow the image.
    const image = argv.indexOf('x:1')
    expect(argv.slice(image + 1)).toEqual(['-c', '--flag with space', '; rm -rf /'])
  })

  test('an env name the process does not carry contributes no -e at all', () => {
    const argv = buildRunArgs('engined-x', { ...SPEC, env: ['ENGINED_TABLES_TEST_ABSENT'] })
    expect(argv).not.toContain('-e')
    expect(argv.some((arg) => arg.startsWith('ENGINED_TABLES_TEST_ABSENT='))).toBe(false)
  })

  test('an env name the process does carry is passed through with its own value intact', () => {
    assignEnv('ENGINED_TABLES_TEST_PRESENT', 'a=b c')
    try {
      const argv = buildRunArgs('engined-x', { ...SPEC, env: ['ENGINED_TABLES_TEST_PRESENT'] })
      expect(argv.slice(argv.indexOf('-e'), argv.indexOf('-e') + 2)).toEqual([
        '-e',
        'ENGINED_TABLES_TEST_PRESENT=a=b c',
      ])
    } finally {
      clearEnv('ENGINED_TABLES_TEST_PRESENT')
    }
  })

  test('no entrypoint leaves --entrypoint off and the command directly after the image', () => {
    const argv = buildRunArgs('engined-x', { ...SPEC, command: ['serve', '--port', '1'] })
    expect(argv).not.toContain('--entrypoint')
    expect(argv.slice(argv.indexOf('x:1'))).toEqual(['x:1', 'serve', '--port', '1'])
  })

  test('the name and network come from the container, and the label carries the spec digest', () => {
    const argv = buildRunArgs('engined-x', SPEC)
    expect(argv.slice(0, 6)).toEqual([
      'run',
      '-d',
      '--name',
      'engined-x',
      '--network',
      'engined-x.net',
    ])
    expect(argv).toContain(`${SPEC_LABEL}=${specDigest(SPEC)}`)
    // docker never receives a publish for the engine itself.
    expect(argv).not.toContain('-p')
  })
})

describe('specDigest', () => {
  test('identity follows the argv, so a changed volume or env is a different container', () => {
    const base = specDigest(SPEC)
    expect(specDigest({ ...SPEC, volumes: [{ name: '/a', path: '/b' }] })).not.toBe(base)
    expect(specDigest({ ...SPEC, devices: ['/dev/dri'] })).not.toBe(base)
    expect(specDigest(SPEC)).toBe(base)
  })
})

describe('proxyRunArgs', () => {
  test('the publish is loopback-only with a docker-chosen host port', () => {
    const argv = proxyRunArgs('engined-x', 8006, 'digest')
    expect(argv[argv.indexOf('-p') + 1]).toBe('127.0.0.1::8006')
    expect(argv).not.toContain('0.0.0.0::8006')
    expect(argv).toContain('--read-only')
    expect(argv[argv.indexOf('--user') + 1]).toBe('65534:65534')
  })
})
