/** The argv gate in front of every CLI mode: which spellings are usage errors, and which fall through to the daemon. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { extraModeExit, HELP } from './extraModes.ts'

const USAGE = 129

let out: string[] = []
let err: string[] = []
const realOut = process.stdout.write.bind(process.stdout)
const realErr = process.stderr.write.bind(process.stderr)

beforeEach(() => {
  out = []
  err = []
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    out.push(String(s))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((s: string | Uint8Array): boolean => {
    err.push(String(s))
    return true
  }) as typeof process.stderr.write
})

afterEach(() => {
  process.stdout.write = realOut
  process.stderr.write = realErr
})

const argv = (...rest: string[]) => ['bun', 'src/main.ts', ...rest]

test.each([
  [['--bogus'], 'unknown flag --bogus'],
  [['--probe', 'extra'], 'unexpected argument extra'],
  [['--out', '/x'], '--out needs --prune-config'],
  [['--prune-config'], '--prune-config needs a path'],
  [['--prune-config', '--json'], '--prune-config needs a path'],
  [['--caddyfile', 't'], '--caddyfile needs TEMPLATE and OUT'],
  [['--engines', '--probe', '--json'], '--engines and --probe are mutually exclusive'],
  [['--json'], '--json requires --engines, --probe, or --doctor'],
  [['--engines'], '--engines requires --json'],
])('%j is a usage error naming the mistake', async (args, message) => {
  expect(await extraModeExit(argv(...args))).toBe(USAGE)
  expect(err.join('')).toContain(message)
})

test('help and version answer on stdout and exit 0', async () => {
  expect(await extraModeExit(argv('-h'))).toBe(0)
  expect(out.join('')).toContain(HELP)
  out = []
  expect(await extraModeExit(argv('--version'))).toBe(0)
  expect(out.join('')).toMatch(/^engined \d/)
})

test('no mode flag falls through to the daemon, with or without a script argument', async () => {
  expect(await extraModeExit(argv())).toBeUndefined()
  expect(await extraModeExit(['engined'])).toBeUndefined()
})

test('a compiled binary has no script argument, so its first argument is the mode', async () => {
  expect(await extraModeExit(['engined', '--bogus'])).toBe(USAGE)
})

test('completion and man are routed before flag parsing', async () => {
  expect(await extraModeExit(argv('man'))).toBe(0)
  expect(out.join('')).toContain('.TH ENGINED 1')
  out = []
  expect(await extraModeExit(argv('completion', 'bash'))).toBe(0)
  expect(out.join('')).toContain('complete')
  expect(await extraModeExit(argv('completion'))).toBe(USAGE)
})

test('a caddyfile with no template arguments is refused before any file is touched', async () => {
  expect(await extraModeExit(argv('--caddyfile'))).toBe(USAGE)
  expect(err.join('')).toContain('--caddyfile needs TEMPLATE and OUT')
})
