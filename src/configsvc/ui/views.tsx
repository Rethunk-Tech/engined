import { computed } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { AddressBookView } from './addressbook.tsx'
import { hopState } from './addresses.ts'
import { call } from './api.ts'
import { ChainsView } from './chains.tsx'
import {
  ensureSpec,
  liveEngines,
  loadSecrets,
  loadUsage,
  secrets,
  upstreamResolver,
  usage,
  watchEngines,
} from './data.ts'
import { DoctorView, report, runDoctor, summary } from './doctor.tsx'
import { EnginesView } from './engines.tsx'
import { HistoryView } from './history.tsx'
import { parseDoc } from './model.ts'
import { ModelsView } from './models.tsx'
import { viewId } from './nav.ts'
import { RawView } from './raw.tsx'
import { SaveView } from './savepanel.tsx'
import { SettingsView } from './settings.tsx'
import { StarterView } from './starterview.tsx'
import { draft, draftDiff, problems, snapshot } from './store.ts'
import { UpstreamsView } from './upstreams.tsx'
import { UsageView } from './usage.tsx'
import { DiffView, plural } from './widgets.tsx'

interface ViewDef {
  id: string
  title: string
  /** Shown in the nav only while this holds. */
  when?: () => boolean
  render: () => preact.JSX.Element
}

const DAY_MS = 86_400_000

function Stat(props: {
  label: string
  value: string | number
  detail?: string
  href: string
  tone?: 'ok' | 'bad'
}) {
  return (
    <a class="stat panel" href={props.href}>
      <span class="section-title">{props.label}</span>
      <span class="stat-value">{props.value}</span>
      {props.detail === undefined ? null : (
        <span class={`small-text ${props.tone ?? 'muted'}`}>{props.detail}</span>
      )}
    </a>
  )
}

const total = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)

function tally(xs: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const x of xs) {
    counts.set(x, (counts.get(x) ?? 0) + 1)
  }
  return [...counts].map(([k, n]) => `${n} ${k}`).join(' · ')
}

function SidePanels(props: {
  busiest: [string, number][]
  saves: { name: string; modified: string }[]
}) {
  const { busiest, saves } = props
  return (
    <div class="cols">
      <div class="panel">
        <h3>Busiest routes, 7 days</h3>
        {busiest.length === 0 ? (
          <p class="muted">No calls recorded.</p>
        ) : (
          <table class="grid">
            <tbody>
              {busiest.map(([route, n]) => (
                <tr key={route}>
                  <td>
                    <code>{route}</code>
                  </td>
                  <td>{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div class="panel">
        <h3>Recent saves</h3>
        {saves.length === 0 ? (
          <p class="muted">No saves through this UI yet.</p>
        ) : (
          <table class="grid">
            <tbody>
              {saves.slice(0, 6).map((s) => (
                <tr key={s.name}>
                  <td>{new Date(s.modified).toLocaleString()}</td>
                  <td>
                    <a href="#history">{s.name}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Overview() {
  const [saves, setSaves] = useState<{ name: string; modified: string }[]>([])
  useEffect(() => {
    const stop = watchEngines()
    void loadUsage()
    void loadSecrets()
    if (report.value === undefined) {
      void runDoctor()
    }
    for (const e of parseDoc(draft.value)?.engine ?? []) {
      void ensureSpec(String(e.id))
    }
    void call<{ entries: { name: string; modified: string }[] }>('/api/history')
      .then((r) => setSaves([...r.entries].sort((a, b) => b.modified.localeCompare(a.modified))))
      .catch(() => setSaves([]))
    return stop
  }, [])
  const saved = snapshot.value
  const d = parseDoc(draft.value)
  const today = new Date().toISOString().slice(0, 10)
  const since = new Date(Date.now() - 6 * DAY_MS).toISOString().slice(0, 10)
  const week = usage.value.filter((r) => r.date >= since)
  const busiest = [
    ...week.reduce(
      (m, r) => m.set(r.route, (m.get(r.route) ?? 0) + r.requests),
      new Map<string, number>(),
    ),
  ]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
  const spend = total(
    usage.value.filter((r) => r.date.startsWith(today.slice(0, 7))).map((r) => r.cost_usd ?? 0),
  )
  const diffLines = draftDiff.value.split('\n')
  const added = diffLines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
  const removed = diffLines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length
  const missingSecrets = secrets.value.filter((s) => !s.present).length
  const checks = report.value?.checks ?? []
  const resolve = d === undefined ? undefined : upstreamResolver(d)
  const dropped =
    d === undefined || resolve === undefined
      ? 0
      : d.chain
          .flatMap((c) => (Array.isArray(c.hops) ? (c.hops as string[]) : []))
          .filter((h) => hopState(d, h, resolve) !== 'ok').length
  return (
    <section>
      {saved !== undefined && (
        <p class="muted small-text">
          {saved.path} · sha256 {saved.sha256.slice(0, 12)} ·{' '}
          {plural(saved.fragments.length, 'config.d fragment')}
        </p>
      )}
      <div class="stats">
        <Stat
          label="Engines"
          value={d?.engine.length ?? 0}
          detail={tally(Object.values(liveEngines.value).map((e) => e.state)) || undefined}
          href="#engines"
        />
        <Stat
          label="Routes"
          value={d?.route.length ?? 0}
          detail={`${d?.route.filter((r) => r.disable === true).length ?? 0} disabled`}
          href="#engines"
        />
        <Stat
          label="Upstreams"
          value={d?.upstream.length ?? 0}
          detail={`${plural(missingSecrets, 'keyring secret')} missing`}
          tone={missingSecrets > 0 ? 'bad' : undefined}
          href="#upstreams"
        />
        <Stat
          label="Chains"
          value={d?.chain.length ?? 0}
          detail={`${plural(dropped, 'hop')} dropped`}
          tone={dropped > 0 ? 'bad' : undefined}
          href="#chains"
        />
        <Stat
          label="Calls today"
          value={total(usage.value.filter((r) => r.date === today).map((r) => r.requests))}
          detail={`${total(week.map((r) => r.requests))} in 7 days · ${total(week.map((r) => r.failed))} failed`}
          href="#usage"
        />
        <Stat label="Spend this month" value={`$${spend.toFixed(2)}`} href="#usage" />
        <Stat
          label="Pending changes"
          value={added + removed === 0 ? 'none' : `+${added} −${removed}`}
          detail={
            problems.value.length === 0 ? 'validates' : plural(problems.value.length, 'problem')
          }
          tone={problems.value.length > 0 ? 'bad' : undefined}
          href="#save"
        />
        <Stat
          label="Host checks"
          value={
            report.value === undefined
              ? '…'
              : `${checks.filter((c) => c.ok).length}/${checks.length}`
          }
          detail={report.value === undefined ? 'checking' : summary(checks)}
          tone={checks.some((c) => !(c.ok || c.skipped)) ? 'bad' : undefined}
          href="#doctor"
        />
      </div>
      <SidePanels busiest={busiest} saves={saves} />
      {draftDiff.value === '' ? null : (
        <div class="panel">
          <h3>Pending changes</h3>
          <DiffView diff={draftDiff.value} />
        </div>
      )}
    </section>
  )
}

const configEmpty = () => (snapshot.value?.text ?? '').trim() === ''

const VIEWS: ViewDef[] = [
  { id: 'starter', title: 'Starter', render: StarterView, when: configEmpty },
  { id: 'overview', title: 'Overview', render: Overview },
  { id: 'engines', title: 'Engines', render: EnginesView },
  { id: 'upstreams', title: 'Upstreams', render: UpstreamsView },
  { id: 'models', title: 'Models', render: ModelsView },
  { id: 'chains', title: 'Chains', render: ChainsView },
  { id: 'addresses', title: 'Address book', render: AddressBookView },
  { id: 'usage', title: 'Usage', render: UsageView },
  { id: 'settings', title: 'Settings', render: SettingsView },
  { id: 'save', title: 'Review & save', render: SaveView },
  { id: 'history', title: 'History', render: HistoryView },
  { id: 'doctor', title: 'Host checks', render: DoctorView },
  { id: 'raw', title: 'Raw TOML', render: RawView },
]

const visible = computed(() => VIEWS.filter((v) => v.when === undefined || v.when()))
const current = computed(
  () => VIEWS.find((v) => v.id === viewId.value) ?? (visible.value[0] as ViewDef),
)

export function ViewNav() {
  return (
    <nav>
      {visible.value.map((v) => (
        <a key={v.id} href={`#${v.id}`} class={current.value.id === v.id ? 'active' : ''}>
          {v.title}
        </a>
      ))}
    </nav>
  )
}

export function View() {
  const Current = current.value.render
  return <Current />
}
