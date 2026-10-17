/** How a route's declared capabilities are layered, shared by the parser and the config UI. */
import { CAPABILITY_FIELDS } from './configKeys.ts'
import type { ModelCapabilities, Role } from './types.ts'

/** Later layers win field by field: the `[[model]]` row, then what the role implies, then the route's own declaration. */
export function mergeCapabilities(...layers: readonly ModelCapabilities[]): ModelCapabilities {
  const merged: ModelCapabilities = {}
  for (const key of CAPABILITY_FIELDS) {
    for (const layer of layers) {
      const v = layer[key]
      if (v !== undefined) {
        ;(merged as Record<string, unknown>)[key] = v
      }
    }
  }
  return merged
}

/**
 * What a role already says about a route's modalities, so a consumer reading
 * the door sees it without a hand-written `[[model]]` row: a `vision` route
 * takes images, a `chat` route takes text, both answer in text. An embedding
 * route says nothing here -- its output is not a modality a caller sends.
 */
export function roleCapabilities(role: Role | undefined): ModelCapabilities {
  if (role === 'vision') {
    return { input: ['text', 'image'], output: ['text'] }
  }
  if (role === 'chat') {
    return { input: ['text'], output: ['text'] }
  }
  return {}
}
