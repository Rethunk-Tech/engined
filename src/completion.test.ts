import { expect, test } from 'bun:test'
import { COMPLETION_SHELLS, generateCompletion, generateMan, helpCommands } from './completion.ts'
import { HELP } from './extraModes.ts'

test('completion and man generation names every top-level command', () => {
  const commands = helpCommands(HELP)
  expect(commands.length).toBeGreaterThan(0)
  const cases = [
    ...COMPLETION_SHELLS.map((shell) => ({ name: shell, text: generateCompletion(shell, HELP) })),
    {
      name: 'man',
      text: generateMan(HELP),
    },
  ]
  for (const { name, text } of cases) {
    expect(text.length, name).toBeGreaterThan(0)
    for (const cmd of commands) {
      expect(text, `${name} omits ${cmd}`).toContain(cmd)
    }
  }
})
