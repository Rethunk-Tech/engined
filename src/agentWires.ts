/** The wire each agent CLI speaks: an agentic engine may only be paired with an upstream on the same one. */
import type { Wire } from './types.ts'

export const AGENT_WIRES = {
  claude: 'anthropic',
  opencode: 'openai',
  cursor: 'openai',
} as const satisfies Record<string, Wire>
