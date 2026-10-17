/** Saving the draft, reloading engined, and the keep-or-revert answer when a reload does not take. */
import { signal } from '@preact/signals'
import { editDraft, refreshStatus, reloadFromDisk } from './actions.ts'
import { ApiError, call } from './api.ts'
import type { RunningStatus } from './banner.ts'
import { parseDoc } from './model.ts'
import { needsEnableDefault, revertTarget, verdict, waitForApply } from './saveflow.ts'
import { draft, lastSavedSha, notice, type Snapshot, snapshot } from './store.ts'

export interface Applied {
  sha256: string
  restart: string[]
  hard_reload_needed: boolean
  changed: string[]
}

export type Phase = 'idle' | 'saving' | 'reloading' | 'verifying'

export const applied = signal<Applied | undefined>()
export const phase = signal<Phase>('idle')
/** The on-disk file, when a save found it changed since this page read it. */
export const conflict = signal<Snapshot | undefined>()
export const keepOrRevert = signal<{ problem: string; mode: 'hot' | 'hard' } | undefined>()
export const applyLog = signal<string[]>([])

const say = (line: string) => {
  applyLog.value = [...applyLog.value, line]
}

async function runSave(text: string, base: string): Promise<boolean> {
  phase.value = 'saving'
  try {
    const result = await call<Applied>('/api/save', { text, base_sha256: base })
    applied.value = result
    conflict.value = undefined
    lastSavedSha.value = result.sha256
    applyLog.value = []
    await reloadFromDisk()
    await refreshStatus()
    return true
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      conflict.value = err.body as Snapshot
    } else {
      notice.value = { kind: 'error', text: err instanceof Error ? err.message : String(err) }
    }
    return false
  } finally {
    phase.value = 'idle'
  }
}

export async function saveDraft(): Promise<void> {
  const parsed = parseDoc(draft.value)
  if (parsed !== undefined && needsEnableDefault(parsed)) {
    await editDraft([{ op: 'setKey', path: ['configsvc', 'enable'], value: true }])
  }
  await runSave(draft.value, snapshot.value?.sha256 ?? '')
}

/** Save over a changed file: the operator has seen the on-disk diff and keeps their text. */
export async function overwriteDisk(): Promise<void> {
  if (conflict.value !== undefined) {
    await runSave(draft.value, conflict.value.sha256)
  }
}

export async function discardForDisk(): Promise<void> {
  conflict.value = undefined
  await reloadFromDisk()
}

const readRunning = (): Promise<RunningStatus | undefined> =>
  call<RunningStatus>('/api/status').catch(() => undefined)

/** Reloads engined by signal, then watches it take (or refuse) the saved config. */
export async function reloadDaemon(mode: 'hot' | 'hard', testAddress?: string): Promise<void> {
  const target = applied.value
  if (target === undefined) {
    return
  }
  keepOrRevert.value = undefined
  phase.value = 'reloading'
  say(`${mode} reload requested`)
  try {
    await call('/api/reload', { mode })
  } catch (err) {
    phase.value = 'idle'
    keepOrRevert.value = { problem: err instanceof Error ? err.message : String(err), mode }
    return
  }
  phase.value = 'verifying'
  const running = await waitForApply(readRunning, target.sha256)
  let routeTest: { status: number; error?: string } | undefined
  if (testAddress !== undefined && running?.config_sha256 === target.sha256) {
    routeTest = await call<{ status: number; error?: string }>('/api/test-route', {
      address: testAddress,
    }).catch((err: unknown) => ({ status: 0, error: String(err) }))
  }
  await refreshStatus()
  phase.value = 'idle'
  const done = verdict({ savedSha: target.sha256, running, routeTest })
  if (done.ok) {
    say('engined runs the saved config')
  } else {
    say(done.problem)
    keepOrRevert.value = { problem: done.problem, mode }
  }
}

export function keepChange(): void {
  keepOrRevert.value = undefined
  say('kept the saved config')
}

/** Restores the file the failed save replaced, then reloads the same way. */
export async function revertLastSave(): Promise<void> {
  const pending = keepOrRevert.value
  if (pending === undefined) {
    return
  }
  const history = await call<{ entries: { name: string }[] }>('/api/history')
  const name = revertTarget(history.entries)
  if (name === undefined) {
    notice.value = { kind: 'error', text: 'there is no earlier version to restore' }
    return
  }
  const restored = await restoreEntry(name)
  if (restored) {
    say(`restored ${name}`)
    await reloadDaemon(pending.mode)
  }
}

export async function restoreEntry(name: string): Promise<boolean> {
  phase.value = 'saving'
  try {
    const result = await call<Applied>('/api/restore', { name })
    applied.value = result
    lastSavedSha.value = result.sha256
    applyLog.value = []
    await reloadFromDisk()
    await refreshStatus()
    return true
  } catch (err) {
    notice.value = { kind: 'error', text: err instanceof Error ? err.message : String(err) }
    return false
  } finally {
    phase.value = 'idle'
  }
}
