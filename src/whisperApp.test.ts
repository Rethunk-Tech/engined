import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { startFakeUpstream } from './test-support.ts'

/**
 * engines/whisper/whisper_app.py's own handler, served by python3 in front of
 * a fake whisper-server; whisper-cli is never reached.
 */
const HARNESS = `
import os, sys
sys.path.insert(0, sys.argv[1])
os.environ["PORT"] = "0"
import whisper_app
from http.server import ThreadingHTTPServer
whisper_app.UPSTREAM = sys.argv[2]
whisper_app.SERVER_ARGV = ["--request-path", "", "--inference-path", "/v1/audio/transcriptions"]
server = ThreadingHTTPServer(("127.0.0.1", 0), whisper_app.Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
`

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

async function startWrapper(upstreamPort: number): Promise<string> {
  const proc = Bun.spawn(
    [
      'python3',
      '-I',
      '-c',
      HARNESS,
      join(import.meta.dir, '..', 'engines', 'whisper'),
      `127.0.0.1:${upstreamPort}`,
    ],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  cleanups.push(() => proc.kill())
  const reader = proc.stdout.getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  return `http://127.0.0.1:${new TextDecoder().decode(value).trim()}`
}

function startUpstream(handler: (req: Request) => Response | Promise<Response>) {
  const upstream = startFakeUpstream(handler)
  cleanups.push(upstream.stop)
  return upstream
}

test('a buffered transcription whose caller hangs up closes the decode behind it', async () => {
  // whisper-server's abort_callback reads a closed connection as the hangup;
  // a proxy that keeps waiting holds the GPU for a transcript nobody reads.
  const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>()
  const { promise: abandoned, resolve: abandon } = Promise.withResolvers<string>()
  const upstream = startUpstream((req) => {
    req.signal.addEventListener('abort', () => abandon('closed'))
    arrive()
    return new Promise<Response>(() => undefined)
  })
  const wrapper = await startWrapper(upstream.port)

  const caller = new AbortController()
  const call = fetch(`${wrapper}/v1/audio/transcriptions`, {
    method: 'POST',
    body: 'audio',
    signal: caller.signal,
  }).catch(() => undefined)
  await arrived
  caller.abort()
  await call

  expect(await Promise.race([abandoned, Bun.sleep(3000).then(() => 'still decoding')])).toBe(
    'closed',
  )
})

test('a WAV header declaring zero-width samples ends in one error frame, not a dropped stream', async () => {
  const upstream = startUpstream(() => new Response('bad audio', { status: 400 }))
  const wrapper = await startWrapper(upstream.port)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(0xff_ff_ff_ff, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  // channels, rate, byte rate, block align, bits: all zero.
  header.write('data', 36)
  header.writeUInt32LE(0xff_ff_ff_ff, 40)
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(header)
      await Bun.sleep(50)
      controller.enqueue(new Uint8Array(4096))
      controller.close()
    },
  })

  const res = await fetch(`${wrapper}/v1/audio/transcriptions/stream`, { method: 'POST', body })
  const frames = (await res.text())
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))

  expect(frames.at(-1)?.phase).toBe('error')
})
