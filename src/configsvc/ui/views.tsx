import { computed, signal } from '@preact/signals'
import { AddressBookView } from './addressbook.tsx'
import { ChainsView } from './chains.tsx'
import { EnginesView } from './engines.tsx'
import { ModelsView } from './models.tsx'
import { RawView } from './raw.tsx'
import { SettingsView } from './settings.tsx'
import { draftDiff, problems, snapshot } from './store.ts'
import { UpstreamsView } from './upstreams.tsx'
import { UsageView } from './usage.tsx'

interface ViewDef {
  id: string
  title: string
  render: () => preact.JSX.Element
}

function Overview() {
  const saved = snapshot.value
  return (
    <section>
      <h2>Overview</h2>
      {saved !== undefined && (
        <p class="muted">
          {saved.path} · sha256 {saved.sha256.slice(0, 12)} · {saved.fragments.length} config.d
          fragment(s)
        </p>
      )}
      <h3>Pending changes</h3>
      {draftDiff.value === '' ? (
        <p class="muted">Nothing pending.</p>
      ) : (
        <pre class="diff">{draftDiff.value}</pre>
      )}
      {problems.value.map((p) => (
        <p class="bad" key={p.message}>
          {p.message}
        </p>
      ))}
    </section>
  )
}

const VIEWS: ViewDef[] = [
  { id: 'overview', title: 'Overview', render: Overview },
  { id: 'engines', title: 'Engines', render: EnginesView },
  { id: 'upstreams', title: 'Upstreams', render: UpstreamsView },
  { id: 'models', title: 'Models', render: ModelsView },
  { id: 'chains', title: 'Chains', render: ChainsView },
  { id: 'addresses', title: 'Address book', render: AddressBookView },
  { id: 'usage', title: 'Usage', render: UsageView },
  { id: 'settings', title: 'Settings', render: SettingsView },
  { id: 'raw', title: 'Raw TOML', render: RawView },
]

const hash = signal(location.hash.slice(1))
addEventListener('hashchange', () => {
  hash.value = location.hash.slice(1)
})

const current = computed(() => VIEWS.find((v) => v.id === hash.value) ?? (VIEWS[0] as ViewDef))

export function ViewNav() {
  return (
    <nav>
      {VIEWS.map((v) => (
        <a key={v.id} href={`#${v.id}`} class={current.value.id === v.id ? 'active' : ''}>
          {v.title}
        </a>
      ))}
    </nav>
  )
}

export function View() {
  return current.value.render()
}
