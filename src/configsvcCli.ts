/** `--configsvc-url` and `--hash-password`: the two operator-facing halves of the config UI's login. */
import process from 'node:process'
import { loadConfig } from './config.ts'
import { errMessage } from './records.ts'

/** The config UI logs exactly `configsvc: <url>` once it is listening; `--configsvc-url` finds that line. */
export const CONFIGSVC_URL_PREFIX = 'configsvc: '
const CONFIGSVC_UNIT = 'engined-configsvc'

export interface JournalRead {
  stdout: string
  exitCode: number
}

async function readConfigsvcJournal(): Promise<JournalRead> {
  const proc = Bun.spawn(
    ['journalctl', '--user', '-u', CONFIGSVC_UNIT, '-o', 'cat', '--no-pager'],
    {
      stdout: 'pipe',
      stderr: 'ignore',
    },
  )
  const stdout = await new Response(proc.stdout).text()
  return { stdout, exitCode: await proc.exited }
}

function configsvcEnabled(): boolean | undefined {
  try {
    return loadConfig().configsvc.enable
  } catch {
    return undefined
  }
}

/** The newest logged URL, or why there is none. */
export async function configsvcUrlExit(
  write: (line: string) => void,
  readJournal: () => Promise<JournalRead> = readConfigsvcJournal,
  enabled: () => boolean | undefined = configsvcEnabled,
): Promise<number> {
  let journal: JournalRead
  try {
    journal = await readJournal()
  } catch (err) {
    process.stderr.write(`could not read the journal: ${errMessage(err)}\n`)
    return 1
  }
  const url = journal.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${CONFIGSVC_URL_PREFIX}http`))
    .at(-1)
  if (url !== undefined) {
    write(url.slice(CONFIGSVC_URL_PREFIX.length))
    return 0
  }
  process.stderr.write(
    enabled() === false
      ? '[configsvc] is not enabled in config.toml: set enable = true, reload, then start engined-configsvc.service\n'
      : `no ${CONFIGSVC_UNIT} URL in the journal: the unit never started or has exited; see systemctl --user status ${CONFIGSVC_UNIT}\n`,
  )
  return 1
}

async function firstStdinLine(): Promise<string> {
  let text = ''
  for await (const chunk of Bun.stdin.stream()) {
    text += new TextDecoder().decode(chunk)
    if (text.includes('\n')) {
      break
    }
  }
  return text.split('\n')[0] ?? ''
}

/** Reads one line and prints its argon2id hash, the form `[configsvc] password_hash` takes. */
export async function hashPasswordExit(
  write: (line: string) => void,
  readLine: () => Promise<string> = firstStdinLine,
): Promise<number> {
  const password = (await readLine()).replace(/\r$/, '')
  if (password === '') {
    process.stderr.write(
      'no password on stdin: pipe one line, for example `read -rs p; echo $p | engined --hash-password`\n',
    )
    return 1
  }
  write(await Bun.password.hash(password, { algorithm: 'argon2id' }))
  return 0
}
