import { describe, expect, test } from 'bun:test'
import { dockerExec } from '../../src/docker.ts'
import { LOCAL } from './exclusive.ts'

/**
 * The program each engine's entrypoint finally exec()s (its Dockerfile CMD or
 * ENTRYPOINT, or the spec's quiet.sh/wrapper). A base-image bump that drops it
 * leaves the container exiting 127 at start, which no unit test sees.
 */
const EXEC_TARGETS: Record<string, string> = {
  'engined-whisper:local': 'python3',
  'engined-comfyui:local': 'python3',
  'engined-kokoro:local': 'uvicorn',
  'engined-piper:local': 'uvicorn',
  'engined-chatterbox-en:local': 'uvicorn',
  'engined-chatterbox-multi:local': 'uvicorn',
  'engined-llama-cpp:local': '/usr/bin/llama-server',
}

describe.skipIf(!LOCAL)('engine images exec their entrypoint program (local)', () => {
  for (const [image, program] of Object.entries(EXEC_TARGETS)) {
    test(`${image} has ${program}`, async () => {
      const r = await dockerExec([
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        image,
        '-c',
        `command -v ${program}`,
      ])
      expect(r.exitCode).toBe(0)
    }, 60_000)
  }
})
