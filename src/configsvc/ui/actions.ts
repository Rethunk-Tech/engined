/** Operations on the shared state: sign-in, loading, the debounced validate and diff of the draft, structured edits. */
import type { EditOp } from '../../editOps.ts'
import { call } from './api.ts'
import {
  draft,
  draftDiff,
  notice,
  type Problem,
  problems,
  type Snapshot,
  type Status,
  session,
  snapshot,
  status,
  statusFault,
} from './store.ts'

const VALIDATE_DELAY_MS = 300
const STATUS_POLL_MS = 5000
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0

export async function login(secret: string): Promise<void> {
  // The server reads `token` or `password` by mode; sending the one value as both lets the form stay mode-blind.
  await call('/login', { password: secret, token: secret })
  session.value = 'in'
  await loadAll()
}

export async function logout(): Promise<void> {
  await call('/logout', {}).catch(() => undefined)
  session.value = 'out'
}

/** Exchanges a `?token=` link for a session and strips it from the address bar. */
export async function bootstrap(): Promise<void> {
  const url = new URL(location.href)
  const token = url.searchParams.get('token')
  if (token !== null) {
    url.searchParams.delete('token')
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    await call('/login', { token }).catch(() => undefined)
  }
  try {
    await loadAll()
    session.value = 'in'
  } catch {
    session.value = 'out'
  }
}

async function loadSnapshot(): Promise<Snapshot> {
  const loaded = await call<Snapshot>('/api/config')
  snapshot.value = loaded
  return loaded
}

/** Replaces the draft with what is on disk now, and drops the pending diff and faults. */
export async function reloadFromDisk(): Promise<void> {
  const loaded = await loadSnapshot()
  draft.value = loaded.text
  draftDiff.value = ''
  problems.value = []
}

async function loadAll(): Promise<void> {
  await reloadFromDisk()
  await refreshStatus()
}

export async function refreshStatus(): Promise<void> {
  try {
    status.value = await call<Status>('/api/status')
    statusFault.value = undefined
  } catch (err) {
    status.value = undefined
    statusFault.value = err instanceof Error ? err.message : String(err)
  }
}

export function startStatusPolling(): () => void {
  const id = setInterval(() => {
    if (session.value === 'in') {
      void refreshStatus()
    }
  }, STATUS_POLL_MS)
  return () => clearInterval(id)
}

async function checkDraft(text: string, mine: number): Promise<void> {
  try {
    const [checked, diffed] = await Promise.all([
      call<{ errors: Problem[] }>('/api/validate', { text }),
      call<{ diff: string }>('/api/diff', { text }),
    ])
    if (mine === generation) {
      problems.value = checked.errors
      draftDiff.value = diffed.diff
    }
  } catch {
    // A 401 already moved the app to sign-in; any other failure leaves the last answer standing.
  }
}

/** Replaces the pending text; the validate result and diff follow after a quiet 300 ms. */
export function setDraft(text: string): void {
  draft.value = text
  generation++
  const mine = generation
  clearTimeout(timer)
  timer = setTimeout(() => void checkDraft(text, mine), VALIDATE_DELAY_MS)
}

export function revertDraft(): void {
  const saved = snapshot.value
  if (saved !== undefined) {
    setDraft(saved.text)
  }
}

/** A structured edit of the draft through the server's comment-preserving editor; a refusal lands in `notice`. */
export async function editDraft(ops: EditOp[]): Promise<boolean> {
  try {
    const edited = await call<{ text: string }>('/api/edit', { text: draft.value, ops })
    notice.value = undefined
    setDraft(edited.text)
    return true
  } catch (err) {
    notice.value = { kind: 'error', text: err instanceof Error ? err.message : String(err) }
    return false
  }
}
