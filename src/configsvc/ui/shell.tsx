import { useEffect, useState } from 'preact/hooks'
import { version as ENGINED_VERSION } from '../../../package.json' with { type: 'json' }
import { login, logout, revertDraft } from './actions.ts'
import { banner } from './banner.ts'
import { dirty, lastSavedSha, notice, snapshot, status, statusFault } from './store.ts'
import { bundleReload, moduleBundleChanged } from './uiBuild.ts'

const BUNDLE_RELOAD = 'configsvc-bundle-reload'

/** The sign-in form is whatever bundle is already in memory. Reload once when the server names another. */
function reloadIfBundleChanged(): void {
  const current = [...document.scripts].map((script) => script.src)
  void fetch('/', { cache: 'no-store' })
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error('bundle'))))
    .then((html) => {
      let guardSet = false
      try {
        guardSet = sessionStorage.getItem(BUNDLE_RELOAD) === '1'
      } catch {
        return
      }
      const decision = bundleReload(moduleBundleChanged(current, html), guardSet)
      try {
        if (decision.clearGuard) {
          sessionStorage.removeItem(BUNDLE_RELOAD)
        }
        if (!decision.reload) {
          return
        }
        sessionStorage.setItem(BUNDLE_RELOAD, '1')
      } catch {
        return
      }
      location.reload()
    })
    .catch(() => undefined)
}

export function SignIn() {
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string>()
  useEffect(() => {
    reloadIfBundleChanged()
  }, [])
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
      <a class="muted" href="#about">
        {ENGINED_VERSION}
      </a>
      {shown === undefined ? null : <span class={`banner ${shown.kind}`}>{shown.text}</span>}
      <span class="grow" />
      {dirty.value ? (
        <>
          <a class="pill" href="#save">
            unsaved changes: review and save
          </a>
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
