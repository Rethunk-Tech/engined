/** The engines this install ships (`engines/<id>/spec.toml`), as the starter wizard needs to see them. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandConfigPath } from './configParse.ts'
import { isRecord } from './records.ts'

export interface ShippedEngine {
  id: string
  kind: string
  upstream: string
  agent?: string
  /** The spec declares `[[artifact]]` entries `obtain` can fetch. */
  artifacts: boolean
  /** Host devices the container needs; the doctor's `/dev/...` checks gate on them. */
  devices: string[]
  /** Where weights are kept, when the engine needs a models_dir; the config writes this tilde form. */
  models_dir?: string
  /** What `models_dir` expands to on this machine. */
  models_path?: string
}

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** The directory a shipped engine's weights default to; llama's is `llm` by the example config's convention. */
function defaultModelsDir(id: string): string {
  return `~/.local/share/engined-models/${id === 'llama' ? 'llm' : id}`
}

export function shippedEngines(enginesRoot: string): ShippedEngine[] {
  let ids: string[]
  try {
    ids = readdirSync(enginesRoot).sort()
  } catch {
    return []
  }
  return ids.flatMap((id): ShippedEngine[] => {
    let text: string
    try {
      text = readFileSync(join(enginesRoot, id, 'spec.toml'), 'utf8')
    } catch {
      return []
    }
    const spec: unknown = Bun.TOML.parse(text)
    if (!(isRecord(spec) && typeof spec.kind === 'string' && typeof spec.upstream === 'string')) {
      return []
    }
    const needsModels =
      text.includes('{models_dir}') || spec.kind === 'comfy' || spec.kind === 'openai-http'
    const dir = needsModels ? defaultModelsDir(id) : undefined
    return [
      {
        id,
        kind: spec.kind,
        upstream: spec.upstream,
        agent: typeof spec.agent === 'string' ? spec.agent : undefined,
        artifacts: Array.isArray(spec.artifact) && spec.artifact.length > 0,
        devices: stringList(spec.devices),
        models_dir: dir,
        models_path: dir === undefined ? undefined : expandConfigPath(dir),
      },
    ]
  })
}
