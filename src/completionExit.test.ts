import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  COMPLETION_SHELLS,
  completionExit,
  generateCompletion,
  generateMan,
  helpCommands,
  manExit,
} from './completion.ts'

const USAGE = 129
const HELP = [
  'usage: x',
  'commands:',
  '  --probe  call the door',
  '  --doctor',
  'flags:',
  '  -h, --help',
  '  --json',
].join('\n')

let err: string[] = []
const realErr = process.stderr.write.bind(process.stderr)
beforeEach(() => {
  err = []
  process.stderr.write = ((s: string | Uint8Array): boolean => {
    err.push(String(s))
    return true
  }) as typeof process.stderr.write
})
afterEach(() => {
  process.stderr.write = realErr
})

const run = (fn: (w: (s: string) => void) => number) => {
  const written: string[] = []
  const code = fn((s) => written.push(s))
  return { code, text: written.join('\n') }
}

test('helpCommands reads only the commands block, and nothing when there is none', () => {
  expect(helpCommands(HELP)).toEqual(['--probe', '--doctor'])
  expect(helpCommands('usage: x\nflags:\n  --json')).toEqual([])
  expect(helpCommands('usage: x\ncommands:\n  --a\n  --b')).toEqual(['--a', '--b'])
})

test('every shell completes the commands and the flags, and an unknown shell is refused', () => {
  for (const shell of COMPLETION_SHELLS) {
    const text = generateCompletion(shell, HELP)
    expect(text, shell).toMatch(/(?:--|-l )probe/)
    expect(text, shell).toMatch(/-(?:-|l )json/)
  }
  expect(() => generateCompletion('tcsh', HELP)).toThrow(
    `supported: ${COMPLETION_SHELLS.join(', ')}`,
  )
})

test('the man page escapes a backslash and a leading dot or quote so roff reads them as text', () => {
  const page = generateMan("a\\b\n.hidden\n'quoted\n\nplain")
  expect(page).toContain('a\\\\b')
  expect(page).toContain('\\&.hidden')
  expect(page).toContain("\\&'quoted")
  expect(page.split('\n')).toContain('.')
  expect(page.startsWith('.TH ENGINED 1')).toBe(true)
})

test.each(['bash', 'zsh', '-h'])('completion %s prints a script or the help and exits 0', (arg) => {
  const { code, text } = run((w) => completionExit([arg], HELP, w))
  expect(code).toBe(0)
  expect(text.length).toBeGreaterThan(0)
})

test.each([[[]], [['bash', 'zsh']], [['tcsh']]])('completion %j is a usage error', (args) => {
  expect(run((w) => completionExit(args, HELP, w)).code).toBe(USAGE)
  expect(err.join('')).toContain('usage: engined completion')
})

test('man prints the page, answers --help, and refuses an argument', () => {
  expect(run((w) => manExit([], HELP, w)).text).toContain('.TH ENGINED 1')
  expect(run((w) => manExit(['--help'], HELP, w)).text).toContain('usage: engined man')
  expect(run((w) => manExit(['extra'], HELP, w)).code).toBe(USAGE)
  expect(err.join('')).toContain('man takes no arguments')
})
