/** CLI modes that act and exit without starting the daemon; `main.ts` asks here before its own argv handling. */

import process from 'node:process'
import { version } from '../package.json' with { type: 'json' }
import { caddyfileExit } from './caddyfile.ts'
import { enginesExit, probeExit } from './cliModes.ts'
import { pruneCli } from './configPrune.ts'
import { configsvcUrlExit, hashPasswordExit } from './configsvcCli.ts'
import { configsvcMain } from './configsvcMain.ts'
import { doctorExit } from './doctor.ts'
import { FatalError } from './errors/fatal.ts'
import { writeToStdout } from './provenance.ts'

const HELP = [
  'usage: engined [flags] <command>',
  'commands:',
  '  --probe [--json]          call the already-serving door; never bind a second one',
  '  --engines --json          print GET /engined/v1/engines; --json is required (no text listing)',
  '  --doctor [--json]         host checks, one line each with its fix; exit 1 when any check fails',
  '  --prune-config CONFIG --out OUTPUT',
  '                            drop duplicate/retired discovery routes; never writes in place',
  '  --configsvc               config web UI (the engined-configsvc unit)',
  '  --configsvc-url           URL the config UI logged at its last start',
  '  --hash-password           one line on stdin -> argon2id hash for [configsvc] password_hash',
  '  --caddyfile TEMPLATE OUT  render the TLS-bridge Caddyfile (the engined-tls unit runs it)',
  'flags:',
  '  -h, --help                print this help',
  '  --version                 print version',
  '  --json                    one JSON document on stdout (with --probe, --engines, or --doctor)',
  '--engines and --probe are mutually exclusive.',
].join('\n')

const KNOWN_FLAGS = new Set([
  '--help',
  '-h',
  '--version',
  '--json',
  '--probe',
  '--engines',
  '--doctor',
  '--prune-config',
  '--out',
  '--configsvc',
  '--configsvc-url',
  '--hash-password',
  '--caddyfile',
])

interface ParsedCli {
  help: boolean
  version: boolean
  json: boolean
  probe: boolean
  engines: boolean
  doctor: boolean
  configsvc: boolean
  configsvcUrl: boolean
  hashPassword: boolean
  prune: boolean
  caddyfile: string[] | undefined
  error?: string
}

const PATH_FLAGS = new Set(['--prune-config', '--out'])

function usageExit(message: string): number {
  process.stderr.write(`engined: ${message}\n${HELP}\n`)
  return FatalError.USAGE_EXIT_CODE
}

function flagArgs(argv: readonly string[]): string[] {
  const start = argv.findIndex((a) => a.startsWith('-'))
  return start === -1 ? [] : argv.slice(start)
}

function parseError(message: string): ParsedCli {
  return {
    help: false,
    version: false,
    json: false,
    probe: false,
    engines: false,
    doctor: false,
    configsvc: false,
    configsvcUrl: false,
    hashPassword: false,
    prune: false,
    caddyfile: undefined,
    error: message,
  }
}

function parseArgv(argv: readonly string[]): ParsedCli {
  const args = flagArgs(argv)
  const flags = new Set<string>()
  let caddyfile: string[] | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (!a.startsWith('-')) {
      return parseError(`unexpected argument ${a}`)
    }
    if (!KNOWN_FLAGS.has(a)) {
      return parseError(`unknown flag ${a}`)
    }
    flags.add(a)
    if (PATH_FLAGS.has(a)) {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('-')) {
        return parseError(`${a} needs a path`)
      }
      i += 1
      continue
    }
    if (a !== '--caddyfile') {
      continue
    }
    const template = args[i + 1]
    const out = args[i + 2]
    if (template === undefined || out === undefined) {
      return parseError('--caddyfile needs TEMPLATE and OUT')
    }
    caddyfile = [template, out]
    i += 2
  }
  return {
    help: flags.has('--help') || flags.has('-h'),
    version: flags.has('--version'),
    json: flags.has('--json'),
    probe: flags.has('--probe'),
    engines: flags.has('--engines'),
    doctor: flags.has('--doctor'),
    configsvc: flags.has('--configsvc'),
    configsvcUrl: flags.has('--configsvc-url'),
    hashPassword: flags.has('--hash-password'),
    prune: flags.has('--prune-config'),
    caddyfile,
    error:
      flags.has('--out') && !flags.has('--prune-config') ? '--out needs --prune-config' : undefined,
  }
}

/** The exit code of a mode that ran, or `undefined` when `argv` names none of them. */
export async function extraModeExit(argv: readonly string[]): Promise<number | undefined> {
  const parsed = parseArgv(argv)
  if (parsed.help) {
    writeToStdout(HELP)
    return 0
  }
  if (parsed.version) {
    writeToStdout(`engined ${version}`)
    return 0
  }
  if (parsed.error !== undefined) {
    return usageExit(parsed.error)
  }
  if (parsed.engines && parsed.probe) {
    return usageExit('--engines and --probe are mutually exclusive')
  }
  if (parsed.json && !parsed.probe && !parsed.engines && !parsed.doctor) {
    return usageExit('--json requires --engines, --probe, or --doctor')
  }
  if (parsed.engines && !parsed.json) {
    return usageExit('--engines requires --json')
  }
  if (parsed.caddyfile !== undefined) {
    return caddyfileExit(parsed.caddyfile, writeToStdout)
  }
  if (parsed.configsvc) {
    return await configsvcMain(writeToStdout)
  }
  if (parsed.doctor) {
    return await doctorExit(parsed.json, writeToStdout)
  }
  if (parsed.configsvcUrl) {
    return await configsvcUrlExit(writeToStdout)
  }
  if (parsed.hashPassword) {
    return await hashPasswordExit(writeToStdout)
  }
  if (parsed.prune) {
    return await pruneCli(argv, writeToStdout)
  }
  if (parsed.engines) {
    return await enginesExit()
  }
  if (parsed.probe) {
    return await probeExit(parsed.json)
  }
  return undefined
}
