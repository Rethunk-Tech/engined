import { useState } from 'preact/hooks'
import { login, logout, revertDraft } from './actions.ts'
import { banner } from './banner.ts'
import { dirty, lastSavedSha, notice, snapshot, status, statusFault } from './store.ts'

export function SignIn() {
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string>()
  const submit = async (event: Event) => {
    event.preventDefault()
    try {
      await login(secret)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <form class="signin panel" onSubmit={submit}>
      <h1>engined config</h1>
      <label>
        Password or sign-in token
        <input
          type="password"
          autocomplete="current-password"
          value={secret}
          onInput={(e) => setSecret(e.currentTarget.value)}
        />
      </label>
      {error !== undefined && <p class="bad">{error}</p>}
      <button type="submit" class="primary">
        Sign in
      </button>
    </form>
  )
}

export function TopBar() {
  const saved = snapshot.value
  const shown =
    saved === undefined
      ? undefined
      : banner({
          savedSha: saved.sha256,
          running: status.value,
          unreachable: statusFault.value,
          lastSavedSha: lastSavedSha.value,
        })
  return (
    <header class="topbar">
      <strong>engined config</strong>
      {shown === undefined ? null : <span class={`banner ${shown.kind}`}>{shown.text}</span>}
      <span class="grow" />
      {dirty.value ? (
        <>
          <span class="pill">unsaved changes</span>
          <button type="button" onClick={revertDraft}>
            Discard
          </button>
        </>
      ) : null}
      <button type="button" onClick={() => void logout()}>
        Sign out
      </button>
    </header>
  )
}

export function Notice() {
  const shown = notice.value
  return shown === undefined ? null : (
    <div class={`notice ${shown.kind}`}>
      {shown.text}{' '}
      <button
        type="button"
        class="small"
        onClick={() => {
          notice.value = undefined
        }}
      >
        Dismiss
      </button>
    </div>
  )
}
