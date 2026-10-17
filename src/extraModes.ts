/** CLI modes that act and exit without starting the daemon; `main.ts` asks here before its own argv handling. */

import { caddyfileExit } from './caddyfile.ts'
import { configsvcUrlExit, hashPasswordExit } from './configsvcCli.ts'
import { configsvcMain } from './configsvcMain.ts'
import { doctorExit } from './doctor.ts'
import { writeToStdout } from './provenance.ts'

const HELP = [
  'Usage: engined [-h|--help] [--probe [--json]] [--engines --json] [--prune-config CONFIG --out OUTPUT]',
  '       engined [--configsvc] [--configsvc-url] [--hash-password] [--caddyfile TEMPLATE OUT] [--doctor [--json]]',
  '--engines prints the JSON from GET /engined/v1/engines and does not start an engine. There is no text listing, so --json is required. --engines and --probe are mutually exclusive.',
  '--configsvc runs the config web UI (the engined-configsvc unit). --configsvc-url prints the URL the engined-configsvc unit last logged. --hash-password reads one line from stdin and prints its argon2id hash for [configsvc] password_hash.',
  '--caddyfile TEMPLATE OUT renders the TLS bridge Caddyfile from its template, adding the config UI site when [configsvc] host is not loopback (the engined-tls unit runs it before Caddy).',
  '--doctor checks the host (docker, GPU devices, bwrap, agents, keyring, ports, models_dir) and prints one line per check with its fix; exit 1 when any check fails.',
].join('\n')

/** The exit code of a mode that ran, or `undefined` when `argv` names none of them. */
export async function extraModeExit(argv: readonly string[]): Promise<number | undefined> {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeToStdout(HELP)
    return 0
  }
  const caddy = argv.indexOf('--caddyfile')
  if (caddy >= 0) {
    return caddyfileExit(argv.slice(caddy + 1), writeToStdout)
  }
  if (argv.includes('--configsvc')) {
    return await configsvcMain(writeToStdout)
  }
  if (argv.includes('--doctor')) {
    return await doctorExit(argv.includes('--json'), writeToStdout)
  }
  if (argv.includes('--configsvc-url')) {
    return await configsvcUrlExit(writeToStdout)
  }
  if (argv.includes('--hash-password')) {
    return await hashPasswordExit(writeToStdout)
  }
  return undefined
}
