import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { handleSpeech } from '../../src/audioSpeech.ts'
import { DockerLifecycle, dockerExec } from '../../src/docker.ts'
import { networkName, proxyName } from '../../src/dockerArgs.ts'
import { bindDoor } from '../../src/listen.ts'
import { loadSpec } from '../../src/spec.ts'
import { isContainerSpec, type RunnableContainerSpec } from '../../src/specTypes.ts'
import { BUNX, ENGINES_ROOT, imageBuilt, LOCAL, specImage, TEST_NAME_PREFIX } from './exclusive.ts'
import { skipTitle } from './fixtures.ts'

/**
 * piper is the one CPU engine, so it is the only real engine this tier starts
 * to prove the isolated network and its port proxy end to end: comfy, llama
 * and the GPU speech engines are a resource other sessions share.
 */
const PIPER = { id: 'piper', args: {}, idle_stop_seconds: 600, ready_timeout_s: 60 }
const PIPER_IMAGE = LOCAL ? specImage(PIPER) : undefined
const HAVE_PIPER = PIPER_IMAGE !== undefined && imageBuilt(PIPER_IMAGE)

const OPTS = { idleStopSeconds: 600, readyTimeoutS: 60 }
const TEST_TIMEOUT_MS = 120_000
const CONNECT_TIMEOUT_S = 3

/** Opens a TCP connection to each `host:port` from inside a container and prints `host:port OPEN|blocked <why>` per line. */
const PROBE_PY = `
import socket, sys
for target in sys.argv[1:]:
    host, port = target.rsplit(':', 1)
    s = socket.socket()
    s.settimeout(${CONNECT_TIMEOUT_S})
    try:
        s.connect((host, int(port)))
        print(target, 'OPEN')
    except Exception as e:
        print(target, 'blocked', type(e).__name__)
    finally:
        s.close()
try:
    socket.gethostbyname('huggingface.co')
    print('dns OPEN')
except Exception as e:
    print('dns blocked', type(e).__name__)
`

/** This host's LAN address and its default gateway, read off the route the internet takes. */
function lanRoute(): { src: string; gateway: string } {
  const out = Bun.spawnSync(['ip', 'route', 'get', '1.1.1.1']).stdout.toString()
  const src = out.match(/\bsrc (\S+)/)?.[1]
  const gateway = out.match(/\bvia (\S+)/)?.[1]
  if (src === undefined || gateway === undefined) {
    throw new Error(`no default route to read: ${out}`)
  }
  return { src, gateway }
}

async function docker(args: string[]): Promise<string> {
  const res = await dockerExec(args)
  return res.stdout.trim()
}

async function exists(kind: 'container' | 'network', name: string): Promise<boolean> {
  return (await dockerExec([kind, 'inspect', name])).exitCode === 0
}

function piperSpec(): RunnableContainerSpec {
  const loaded = loadSpec(PIPER, { enginesRoot: ENGINES_ROOT, bunx: BUNX })
  if (!isContainerSpec(loaded.spec)) {
    throw new Error('piper spec.toml did not parse as a container spec')
  }
  return loaded.spec
}

/** The piper image running a websocket echo that answers each message after a pause, so the connection sits idle in the proxy between frames. */
function websocketEchoSpec(): RunnableContainerSpec {
  const app = `
import asyncio, uvicorn
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route, WebSocketRoute
async def health(request): return PlainTextResponse('ok')
async def echo(ws):
    await ws.accept()
    async for message in ws.iter_text():
        await asyncio.sleep(1.5)
        await ws.send_text(message[::-1])
uvicorn.run(Starlette(routes=[Route('/health', health), WebSocketRoute('/ws', echo)]), host='0.0.0.0', port=8006, log_level='warning')
`
  return { ...piperSpec(), entrypoint: ['python3'], command: ['-c', app] }
}

describe.skipIf(!HAVE_PIPER)(
  skipTitle('isolated engine network (local)', HAVE_PIPER, `${PIPER_IMAGE} is not built`),
  () => {
    const id = 'isolation-piper'
    const engine = `${TEST_NAME_PREFIX}${id}`
    const lifecycle = new DockerLifecycle(dockerExec, undefined, TEST_NAME_PREFIX)
    let door: ReturnType<typeof bindDoor> = []

    beforeAll(() => {
      door = bindDoor(() => new Response('door'), 0)
    })

    afterAll(async () => {
      for (const s of door) {
        s.stop(true)
      }
      await lifecycle.shutdown()
      await dockerExec(['rm', '-f', engine, proxyName(engine)])
      await dockerExec(['network', 'rm', '-f', networkName(engine)])
    }, TEST_TIMEOUT_MS)

    test(
      'piper speaks through its proxy, and from inside it reaches neither the door, the LAN nor the internet',
      async () => {
        const spec = piperSpec()
        const status = await lifecycle.start(id, spec, OPTS)
        expect(status.state).toBe('running')

        const spoken = await handleSpeech(
          { engine: id, input: 'The quick brown fox.' },
          async () => ({
            private_url: status.private_url,
          }),
        )
        expect(spoken.status).toBe(200)
        expect(Buffer.from((spoken.bytes as Uint8Array).slice(0, 4)).toString('ascii')).toBe('RIFF')

        const doorPort = door[0]?.port
        const { src, gateway } = lanRoute()
        const bridgeGateway = await docker([
          'network',
          'inspect',
          'bridge',
          '-f',
          '{{(index .IPAM.Config 0).Gateway}}',
        ])
        const targets = [
          `${bridgeGateway}:${doorPort}`,
          `${src}:${doorPort}`,
          `${gateway}:53`,
          `${gateway}:80`,
          '1.1.1.1:443',
          '8.8.8.8:53',
        ]
        const inside = await docker(['exec', engine, 'python3', '-c', PROBE_PY, ...targets])
        for (const line of inside.split('\n')) {
          expect(line).toContain('blocked')
        }

        // The same probe from docker's default bridge reaches the door, so a
        // blocked line above is the network's doing, not the probe's.
        const control = await docker([
          'run',
          '--rm',
          '--entrypoint',
          'python3',
          spec.image,
          '-c',
          PROBE_PY,
          `${bridgeGateway}:${doorPort}`,
        ])
        expect(control.split('\n')[0]).toBe(`${bridgeGateway}:${doorPort} OPEN`)
      },
      TEST_TIMEOUT_MS,
    )

    test(
      'a proxy that dies takes the engine down with it, and the network goes too',
      async () => {
        const started = await lifecycle.start(id, piperSpec(), OPTS)
        expect(started.state).toBe('running')
        await dockerExec(['kill', proxyName(engine)])

        expect((await lifecycle.probe(id, piperSpec())).state).toBe('installed')
        expect(await docker(['inspect', '-f', '{{.State.Running}}', engine])).toBe('false')
        expect(await exists('container', proxyName(engine))).toBe(false)
        expect(await exists('network', networkName(engine))).toBe(false)
      },
      TEST_TIMEOUT_MS,
    )

    test(
      'a pair an unclean exit left running is adopted on its port; stop removes the proxy and network',
      async () => {
        const started = await lifecycle.start(id, piperSpec(), OPTS)
        // A second lifecycle is what the next engined process sees: an empty map and a live pair.
        const next = new DockerLifecycle(dockerExec, undefined, TEST_NAME_PREFIX)
        const adopted = await next.probe(id, piperSpec())
        expect(adopted.adopted).toBe(true)
        expect(adopted.private_url).toBe(started.private_url)

        await next.stop(id)
        expect(await docker(['inspect', '-f', '{{.State.Running}}', engine])).toBe('false')
        expect(await exists('container', proxyName(engine))).toBe(false)
        expect(await exists('network', networkName(engine))).toBe(false)
      },
      TEST_TIMEOUT_MS,
    )

    test(
      'a websocket upgrade and idle-gapped frames pass through the proxy',
      async () => {
        const status = await lifecycle.start(`${id}-ws`, websocketEchoSpec(), OPTS)
        expect(status.state).toBe('running')
        const ws = new WebSocket(`ws://${status.private_url}/ws`)
        const replies: string[] = []
        const done = new Promise<void>((resolve, reject) => {
          ws.onerror = () => reject(new Error('websocket error'))
          ws.onmessage = (event) => {
            replies.push(String(event.data))
            if (replies.length === 2) {
              resolve()
            } else {
              setTimeout(() => ws.send('second'), 2000)
            }
          }
        })
        ws.onopen = () => ws.send('first')
        await done
        ws.close()
        expect(replies).toEqual(['tsrif', 'dnoces'])
        await lifecycle.stop(`${id}-ws`)
        await dockerExec(['rm', '-f', `${engine}-ws`])
      },
      TEST_TIMEOUT_MS,
    )
  },
)
