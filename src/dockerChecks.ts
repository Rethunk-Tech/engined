import { checkArtifacts, checkImage, type Result } from './dockerCommands.ts'
import type { Exec } from './exec.ts'
import type { Runtime } from './runtimeTable.ts'
import type { RunnableContainerSpec } from './specTypes.ts'

/** Run when the engine is first asked for; cached until it next starts. A failed check is never cached: only a fix (e.g. `docker pull`) can make it pass, and that fix happens outside this process. */
export async function ensureImageChecked(
  exec: Exec,
  rt: Runtime,
  spec: RunnableContainerSpec,
  specSource?: string,
): Promise<Result<{ containerPort: number }>> {
  if (!rt.imageCheck) {
    rt.imageCheck = checkImage(exec, spec, specSource)
  }
  const result = await rt.imageCheck
  if (!result.ok) {
    rt.imageCheck = null
  }
  return result
}

/** Run when the engine is first asked for; cached until it next starts. A failed check is never cached: only a fix can make it pass, and the fix happens outside this process. */
export async function ensureArtifactsChecked(
  exec: Exec,
  rt: Runtime,
  spec: RunnableContainerSpec,
): Promise<Result> {
  if (spec.artifacts.length === 0) {
    return { ok: true }
  }
  if (!rt.artifactCheck) {
    rt.artifactCheck = checkArtifacts(exec, spec)
  }
  const result = await rt.artifactCheck
  if (!result.ok) {
    rt.artifactCheck = null
  }
  return result
}
