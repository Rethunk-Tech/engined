import { effect } from '@preact/signals'
import { render } from 'preact'
import { useEffect } from 'preact/hooks'
import { bootstrap, startStatusPolling } from './actions.ts'
import { fork } from './api.ts'
import { Notice, SignIn, TopBar } from './shell.tsx'
import { session } from './store.ts'
import { bundleReload, moduleBundleChanged } from './uiBuild.ts'
import { View, ViewNav } from './views.tsx'

const BUNDLE_RELOAD = 'configsvc-bundle-reload'

/** This tab runs whatever bundle it loaded. Reload once when the server now serves another. */
function reloadIfBundleChanged(): void {
  const current = [...document.scripts].map((script) => script.src)
  fork(
    fetch('/', { cache: 'no-store' })
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
      .catch(() => undefined),
  )
}

export function App() {
  useEffect(() => {
    fork(bootstrap())
    return startStatusPolling()
  }, [])
  if (session.value === 'checking') {
    return <p className="muted pad">Loading…</p>
  }
  if (session.value === 'out') {
    return <SignIn />
  }
  return (
    <>
      <TopBar />
      <Notice />
      <div className="layout">
        <ViewNav />
        <main>
          <View />
        </main>
      </div>
    </>
  )
}

const root = document.getElementById('app')
if (root !== null) {
  // On load (a match clears the guard), when a restart drops the session, and on sign-in: the
  // server may have restarted onto a new bundle while the sign-in form sat open.
  effect(() => {
    if (session.value !== 'checking') {
      reloadIfBundleChanged()
    }
  })
  render(<App />, root)
}
