/** The Add wizard's provider path: everything engined needs to serve a hosted API, as edits to the pending config. */
import type { EditOp } from '../../editOps.ts'
import type { Wire } from '../../types.ts'
import type { Doc } from './model.ts'

export interface Preset {
  id: string
  label: string
  base_url: string
  wire: Wire
  header: string
  scheme?: string
}

/** Base URLs and key headers as each provider's own API docs give them. */
export const PRESETS: Preset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    wire: 'openai',
    header: 'authorization',
    scheme: 'Bearer',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1',
    wire: 'openai',
    header: 'authorization',
    scheme: 'Bearer',
  },
  {
    id: 'googleai',
    label: 'Google AI (Gemini)',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    wire: 'openai',
    header: 'authorization',
    scheme: 'Bearer',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    // No /v1: the claude CLI that serves this wire appends /v1/messages itself.
    base_url: 'https://api.anthropic.com',
    wire: 'anthropic',
    header: 'x-api-key',
  },
  {
    id: 'groq',
    label: 'Groq',
    base_url: 'https://api.groq.com/openai/v1',
    wire: 'openai',
    header: 'authorization',
    scheme: 'Bearer',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    base_url: 'https://api.mistral.ai/v1',
    wire: 'openai',
    header: 'authorization',
    scheme: 'Bearer',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    base_url: 'https://api.deepseek.com',
    wire: 'openai',
    header: 'authorization',
    scheme: 'Bearer',
  },
]

export interface ProviderPlan {
  id: string
  base_url: string
  wire: Wire
  header: string
  scheme?: string
  service: string
  username: string
  /** Every model the provider lists, or these ids exactly as the provider names them. */
  models: '*' | string[]
}

/** The engine an anthropic-wire upstream is served through: the shipped claude CLI engine. */
const ANTHROPIC_ENGINE = 'claude'

/** Wildcard routes refresh the provider's /models list on these defaults. */
const INVENTORY = { inventory_max_age_seconds: 86_400, inventory_refresh_seconds: 3600 }

/** `base`, or `base-2`, `base-3`... when an entry already holds the name. */
export function freeId(taken: readonly unknown[], base: string): string {
  let id = base
  for (let n = 2; taken.includes(id); n++) {
    id = `${base}-${n}`
  }
  return id
}

/** The engine the plan's routes run on: one openai-http engine per provider, or the claude CLI for the anthropic wire. */
export function engineFor(plan: ProviderPlan): string {
  return plan.wire === 'anthropic' ? ANTHROPIC_ENGINE : plan.id
}

export function providerOps(doc: Doc, plan: ProviderPlan): EditOp[] {
  const engine = engineFor(plan)
  const ops: EditOp[] = [
    {
      op: 'addEntry',
      table: 'upstream',
      entry: {
        id: plan.id,
        base_url: plan.base_url,
        secret: {
          service: plan.service,
          username: plan.username,
          header: plan.header,
          ...(plan.scheme === undefined ? {} : { scheme: plan.scheme }),
        },
        egress: 'remote',
        wire: plan.wire,
        ...(plan.models === '*' ? INVENTORY : {}),
      },
    },
  ]
  if (!doc.engine.some((e) => e.id === engine)) {
    ops.push({
      op: 'addEntry',
      table: 'engine',
      entry: plan.wire === 'anthropic' ? { id: engine } : { id: engine, kind: 'openai-http' },
    })
  }
  for (const model of plan.models === '*' ? ['*'] : plan.models) {
    ops.push({ op: 'addEntry', table: 'route', entry: { engine, upstream: plan.id, model } })
  }
  return ops
}
