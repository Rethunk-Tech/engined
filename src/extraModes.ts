/** CLI modes that act and exit without starting the daemon; `main.ts` asks here before its own argv handling. */

import { configsvcUrlExit, hashPasswordExit } from './configsvcCli.ts'
import { doctorExit } from './doctor.ts'
import { writeToStdout } from './provenance.ts'

const HELP = [
  'Usage: engined [-h|--help] [--probe [--json]] [--engines --json] [--prune-config CONFIG --out OUTPUT]',
  '       engined [--configsvc-url] [--hash-password] [--doctor [--json]]',
  '--engines prints the JSON from GET /engined/v1/engines and does not start an engine. There is no text listing, so --json is required. --engines and --probe are mutually exclusive.',
  '--configsvc-url prints the URL the engined-configsvc unit last logged. --hash-password reads one line from stdin and prints its argon2id hash for [configsvc] password_hash.',
  '--doctor checks the host (docker, GPU devices, bwrap, agents, keyring, ports, models_dir) and prints one line per check with its fix; exit 1 when any check fails.',
].join('\n')

/** The exit code of a mode that ran, or `undefined` when `argv` names none of them. */
export async function extraModeExit(argv: readonly string[]): Promise<number | undefined> {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeToStdout(HELP)
    return 0
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
