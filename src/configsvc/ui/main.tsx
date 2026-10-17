import { render } from 'preact'
import { useEffect } from 'preact/hooks'
import { bootstrap, startStatusPolling } from './actions.ts'
import { SignIn, TopBar } from './shell.tsx'
import { session } from './store.ts'
import { View, ViewNav } from './views.tsx'

function App() {
  useEffect(() => {
    void bootstrap()
    return startStatusPolling()
  }, [])
  if (session.value === 'checking') {
    return <p class="muted pad">Loading…</p>
  }
  if (session.value === 'out') {
    return <SignIn />
  }
  return (
    <>
      <TopBar />
      <div class="layout">
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
