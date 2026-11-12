import { useState } from 'preact/hooks'
import { version as ENGINED_VERSION } from '../../../package.json' with { type: 'json' }
import { login, logout, revertDraft } from './actions.ts'
import { fork } from './api.ts'
import { banner } from './banner.ts'
import { dirty, lastSavedSha, notice, snapshot, status, statusFault } from './store.ts'

const DISMISS = 'Dismiss'
const SIGN_OUT = 'Sign out'
const DISCARD = 'Discard'
const UNSAVED_CHANGES_REVIEW_AND = 'unsaved changes: review and save'
const ENGINED_CONFIG = 'engined config'
const SIGN_IN = 'Sign in'
const PASSWORD_OR_SIGN_IN = 'Password or sign-in token'

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
      <h1>{ENGINED_CONFIG}</h1>
      <label>
        {PASSWORD_OR_SIGN_IN}
        <input
          type="password"
          autoComplete="current-password"
          value={secret}
          onInput={(e) => setSecret(e.currentTarget.value)}
        />
      </label>
      {error !== undefined && <p className="bad">{error}</p>}
      <button type="submit" className="primary">
        {SIGN_IN}
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
      <strong>{ENGINED_CONFIG}</strong>
      <a className="muted" href="#about">
        {ENGINED_VERSION}
      </a>
      {shown === undefined ? null : <span className={`banner ${shown.kind}`}>{shown.text}</span>}
      <span className="grow" />
      {dirty.value ? (
        <>
          <a className="pill" href="#save">
            {UNSAVED_CHANGES_REVIEW_AND}
          </a>
          <button type="button" onClick={revertDraft}>
            {DISCARD}
          </button>
        </>
      ) : null}
      <button type="button" onClick={() => fork(logout())}>
        {SIGN_OUT}
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
        {DISMISS}
      </button>
    </div>
  )
}
