/** Shared UI state: the session, the config on disk, the pending draft and what engined reports. */
import { computed, signal } from '@preact/signals'
import type { RunningStatus } from './banner.ts'

interface Fragment {
  file: string
  text: string
}

export interface Snapshot {
  path: string
  text: string
  sha256: string
  fragments: Fragment[]
}

export interface Problem {
  message: string
  file?: string
  line?: number
  column?: number
  path?: { table?: string; index?: number; key?: string; file?: string }
}

export interface Status extends RunningStatus {
  contract?: number
  commit?: string
  engines?: unknown[]
}

export const session = signal<'checking' | 'out' | 'in'>('checking')
export const snapshot = signal<Snapshot | undefined>()
/** The pending text. It equals the snapshot text when nothing is changed. */
export const draft = signal('')
export const draftDiff = signal('')
export const problems = signal<Problem[]>([])
export const status = signal<Status | undefined>()
export const statusFault = signal<string | undefined>()
export const lastSavedSha = signal<string | undefined>()

export const dirty = computed(
  () => snapshot.value !== undefined && draft.value !== snapshot.value.text,
)
