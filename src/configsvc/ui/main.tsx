import { render } from 'preact'
import { useEffect } from 'preact/hooks'
import { bootstrap, startStatusPolling } from './actions.ts'
import { fork } from './api.ts'
import { Notice, SignIn, TopBar } from './shell.tsx'
import { session } from './store.ts'
import { View, ViewNav } from './views.tsx'

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
  render(<App />, root)
}
