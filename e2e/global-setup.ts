import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** Starts e2e/serve.ts under bun and hands the test its URL and scratch config path. */
export default async function globalSetup(): Promise<() => void> {
  const child = spawn('bun', [join(import.meta.dirname, 'serve.ts')], {
    stdio: ['ignore', 'pipe', 'inherit'],
    // Bundled the way a release serves the page, without Bun's development client.
    env: { ...process.env, NODE_ENV: 'production', E2E: '1' },
  })
  const ready = await new Promise<{ url: string; configFile: string }>((resolve, reject) => {
    let seen = ''
    child.stdout.on('data', (chunk: Buffer) => {
      seen += chunk.toString()
      const line = seen.split('\n').find((l) => l.startsWith('READY '))
      if (line !== undefined) {
        resolve(JSON.parse(line.slice('READY '.length)) as { url: string; configFile: string })
      }
    })
    child.once('exit', (code) =>
      reject(new Error(`e2e/serve.ts exited ${code} before it was ready`)),
    )
    setTimeout(() => reject(new Error('e2e/serve.ts was not ready in 40 s')), 40_000)
  })
  process.env.E2E_URL = ready.url
  process.env.E2E_CONFIG = ready.configFile
  return () => {
    child.kill('SIGTERM')
  }
}
