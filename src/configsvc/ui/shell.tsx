import { useState } from 'preact/hooks'
import { version as ENGINED_VERSION } from '../../../package.json' with { type: 'json' }
import { login, logout, revertDraft } from './actions.ts'
import { fork } from './api.ts'
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
    <form className="signin panel" onSubmit={submit}>
      <h1>engined config</h1>
      <label>
        Password or sign-in token
        <input
          type="password"
          autoComplete="current-password"
          value={secret}
          onInput={(e) => setSecret(e.currentTarget.value)}
        />
      </label>
      {error !== undefined && <p className="bad">{error}</p>}
      <button type="submit" className="primary">
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
    <header className="topbar">
      <strong>engined config</strong>
      <a className="muted" href="#about">
        {ENGINED_VERSION}
      </a>
      {shown === undefined ? null : <span className={`banner ${shown.kind}`}>{shown.text}</span>}
      <span className="grow" />
      {dirty.value ? (
        <>
          <a className="pill" href="#save">
            unsaved changes: review and save
          </a>
          <button type="button" onClick={revertDraft}>
            Discard
          </button>
        </>
      ) : null}
      <button type="button" onClick={() => fork(logout())}>
        Sign out
      </button>
    </header>
  )
}

export function Notice() {
  const shown = notice.value
  return shown === undefined ? null : (
    <div className={`notice ${shown.kind}`}>
      {shown.text}{' '}
      <button
        type="button"
        className="small"
        onClick={() => {
          notice.value = undefined
        }}
      >
        Dismiss
      </button>
    </div>
  )
}
