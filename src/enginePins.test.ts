import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ENGINES = join(dirname(import.meta.dir), 'engines')
const SHA256 = /@sha256:[0-9a-f]{64}/
const GIT_SHA = /@[0-9a-f]{40}/

function dockerfiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      out.push(...dockerfiles(p))
    } else if (name === 'Dockerfile') {
      out.push(p)
    }
  }
  return out
}

function instructionLines(text: string): string[] {
  return text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return t.length > 0 && !t.startsWith('#')
    })
}

function copyFromSource(line: string): string | undefined {
  const m = line.match(/COPY --from=(\S+)/)
  return m?.[1]
}

function isStageOrContext(source: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(source)
}

test('install.sh pins the TLS terminator image by digest', () => {
  const script = readFileSync(join(dirname(ENGINES), 'scripts', 'install.sh'), 'utf8')
  expect(script).toMatch(new RegExp(`CADDY_IMAGE="\\S+${SHA256.source}"`))
})

describe('engine Dockerfiles pin every build input', () => {
  const files = dockerfiles(ENGINES)
  test('engines/ contains Dockerfiles', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    const rel = file.slice(ENGINES.length + 1)
    test(`${rel} has no floating tags, branch refs, or unpinned wheels`, () => {
      const lines = instructionLines(readFileSync(file, 'utf8'))
      const joined = lines.join('\n')
      expect(joined).not.toMatch(/:(latest|master|main)(?:\s|@|$)/)
      expect(joined).not.toMatch(/git\+https?:\/\/\S+@(master|main|HEAD)\b/)
      expect(joined).not.toMatch(/huggingface\.co\/\S+\/resolve\/main\//)
      expect(joined).not.toMatch(/git clone --branch /)

      for (const line of lines) {
        if (/^FROM\s+/.test(line.trim())) {
          expect(line).toMatch(SHA256)
        }
        const from = copyFromSource(line)
        if (from !== undefined && !isStageOrContext(from)) {
          expect(from).toMatch(SHA256)
          expect(from).not.toMatch(/:latest(?:@|$)/)
        }
        if (line.includes('git+')) {
          expect(line).toMatch(GIT_SHA)
        }
        if (/pip install/.test(line)) {
          const args = line.slice(line.indexOf('pip install')).split(/\s+/)
          expect(
            args.filter((tok) => tok === 'torch' || tok === 'torchvision' || tok === 'torchaudio'),
          ).toEqual([])
        }
      }
    })
  }
})
