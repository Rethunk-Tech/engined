/** Suggestion lists for route fields, drawn from the config, the discovery caches and the model directories. Advisory. */
import type { ModelFile } from './data.ts'
import type { Doc } from './model.ts'
import { isTable } from './model.ts'

interface Discovery {
  providers: Record<string, unknown>
  inventories: Record<string, unknown>
}

/** `[[model]]` rows, what the engine's provider lists, and the upstream's catalog; ids with a slash cannot be address segments and are left out. */
export function modelSuggestions(
  doc: Doc,
  engineId: string,
  upstream: string | undefined,
  found: Discovery,
): string[] {
  const out = new Set<string>(doc.model.flatMap((m) => (typeof m.id === 'string' ? [m.id] : [])))
  const provider = found.providers[engineId]
  const listed = isTable(provider) && Array.isArray(provider.models) ? provider.models : []
  for (const m of listed) {
    if (isTable(m) && typeof m.segment === 'string') {
      out.add(m.segment)
    }
  }
  const inventory = upstream === undefined ? undefined : found.inventories[upstream]
  const ids = isTable(inventory) && Array.isArray(inventory.ids) ? inventory.ids : []
  for (const id of ids) {
    if (typeof id === 'string' && !id.includes('/')) {
      out.add(id)
    }
  }
  return [...out].sort((a, b) => Number(a > b) - Number(a < b))
}

/** The weights context window of the file a route names, when it is a readable GGUF. */
export function trainedContext(
  files: readonly ModelFile[],
  filename: string | undefined,
): number | undefined {
  return filename === undefined
    ? undefined
    : files.find((f) => f.path === filename || f.path.endsWith(`/${filename}`))?.gguf
        ?.context_length
}

export function findModelFile(
  files: readonly ModelFile[],
  filename: unknown,
): ModelFile | undefined {
  return typeof filename === 'string'
    ? files.find((f) => f.path === filename || f.path.endsWith(`/${filename}`))
    : undefined
}

const COMFY_DIRS: Record<string, string[]> = {
  unet: ['unet', 'diffusion_models', 'checkpoints'],
  clip: ['clip', 'text_encoders'],
  vae: ['vae'],
}

/** File names under the directories a comfy graph loads `key` from (the whole listing when the key is not a loader). */
export function comfyChoices(files: readonly ModelFile[], key: string): string[] {
  const dirs = COMFY_DIRS[key]
  const names = files
    .filter((f) => dirs === undefined || dirs.some((d) => f.path.split('/').includes(d)))
    .map((f) => f.path.split('/').pop() ?? f.path)
  return [...new Set(names)].sort((a, b) => Number(a > b) - Number(a < b))
}

export function formatBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
