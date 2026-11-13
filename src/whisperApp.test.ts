import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_AUDIO_UPLOAD_BYTES } from './audioDoorTranscribe.ts'
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
if len(sys.argv) > 3:
    whisper_app.BIN_DIR = sys.argv[3]
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

async function startWrapper(
  upstreamPort: number,
  limits: Record<string, string> = {},
  binDir?: string,
): Promise<string> {
  const proc = Bun.spawn(
    [
      'python3',
      '-I',
      '-c',
      HARNESS,
      join(import.meta.dir, '..', 'engines', 'whisper'),
      `127.0.0.1:${upstreamPort}`,
      ...(binDir === undefined ? [] : [binDir]),
    ],
    { stdout: 'pipe', stderr: 'ignore', env: { ...process.env, ...limits } },
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

test.each(['/v1/audio/transcriptions', '/v1/audio/transcriptions/stream'])(
  '%s refuses a declared body over the upload limit with 413',
  async (path) => {
    const wrapper = new URL(await startWrapper(1))
    // fetch cannot declare a length it does not send, so the request is written raw.
    const { promise: done, resolve } = Promise.withResolvers<string>()
    let received = ''
    await Bun.connect({
      hostname: wrapper.hostname,
      port: Number(wrapper.port),
      socket: {
        open(sock) {
          sock.write(
            `POST ${path} HTTP/1.1\r\nhost: x\r\ncontent-length: ${MAX_AUDIO_UPLOAD_BYTES + 1}\r\n\r\n`,
          )
        },
        data(_sock, chunk) {
          received += chunk.toString()
        },
        close() {
          resolve(received)
        },
      },
    })
    expect((await done).split('\r\n')[0]).toContain('413')
  },
)

/** A whisper-cli that records each start and holds until `release` exists, then prints one segment. */
function fakeCli() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-cli-'))
  const started = join(dir, 'started')
  const release = join(dir, 'release')
  writeFileSync(started, '')
  writeFileSync(
    join(dir, 'whisper-cli'),
    `#!/bin/sh\necho $$ >> ${started}\nwhile [ ! -e ${release} ]; do sleep 0.05; done\necho '[00:00:00.000 --> 00:00:01.000]   hi'\n`,
  )
  chmodSync(join(dir, 'whisper-cli'), 0o755)
  return {
    dir,
    starts: () => readFileSync(started, 'utf8').split('\n').filter(Boolean).length,
    release: () => writeFileSync(release, ''),
  }
}

const streamPost = (wrapper: string) =>
  fetch(`${wrapper}/v1/audio/transcriptions/stream`, { method: 'POST', body: new Uint8Array(16) })

async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) {
    await Bun.sleep(25)
  }
}

test('a decode past WHISPER_MAX_CONCURRENT waits for a slot instead of starting another whisper-cli', async () => {
  const cli = fakeCli()
  const upstream = startUpstream(() => Response.json({ text: 'ok' }))
  const wrapper = await startWrapper(
    upstream.port,
    { WHISPER_MAX_CONCURRENT: '2', WHISPER_MAX_QUEUE: '4' },
    cli.dir,
  )
  const calls = [streamPost(wrapper), streamPost(wrapper), streamPost(wrapper)]
  await until(() => cli.starts() === 2)
  await Bun.sleep(400)
  expect(cli.starts()).toBe(2)
  cli.release()
  const bodies = await Promise.all((await Promise.all(calls)).map((r) => r.text()))
  expect(cli.starts()).toBe(3)
  for (const body of bodies) {
    expect(body).toContain('"phase": "done"')
  }
})

test('a request past the queue bound is answered 503', async () => {
  const cli = fakeCli()
  const upstream = startUpstream(() => Response.json({ text: 'ok' }))
  const wrapper = await startWrapper(
    upstream.port,
    { WHISPER_MAX_CONCURRENT: '1', WHISPER_MAX_QUEUE: '1' },
    cli.dir,
  )
  const running = streamPost(wrapper)
  await until(() => cli.starts() === 1)
  const queued = streamPost(wrapper)
  await Bun.sleep(300)
  const refused = await streamPost(wrapper)
  expect(refused.status).toBe(503)
  expect(await refused.text()).toContain('retry')
  cli.release()
  expect((await running).status).toBe(200)
  expect((await queued).status).toBe(200)
})
