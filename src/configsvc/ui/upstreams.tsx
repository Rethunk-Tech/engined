import { computed } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { editDraft } from './actions.ts'
import { call } from './api.ts'
import {
  discovery,
  loadDiscovery,
  loadSecrets,
  loadUsage,
  monthSpend,
  secrets,
  upstreamResolver,
} from './data.ts'
import { DeleteGuard } from './guardPanel.tsx'
import { type Doc, parseDoc, routeAddress, type Table } from './model.ts'
import { loadSchema } from './schema.ts'
import { entryToToml } from './snippet.ts'
import { SnippetBox } from './snippets.tsx'
import { draft } from './store.ts'
import { CopyButton, Labeled, Prop } from './widgets.tsx'

const doc = computed(() => parseDoc(draft.value))

const FIELDS = [
  'base_url',
  'egress',
  'wire',
  'disable',
  'inventory_max_age_seconds',
  'inventory_refresh_seconds',
  'monthly_cap_usd',
] as const

function Headers({ index, headers }: { index: number; headers: unknown }) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const rows =
    typeof headers === 'object' && headers !== null ? Object.entries(headers as Table) : []
  return (
    <div class="argsbox">
      <strong>headers</strong>
      {rows.map(([k, v]) => (
        <div class="argrow" key={k}>
          <code>{k}</code>
          <code>{String(v)}</code>
          <button
            type="button"
            class="small"
            onClick={() =>
              void editDraft([
                { op: 'setKey', path: ['upstream', index, 'headers', k], value: undefined },
              ])
            }
          >
            Remove
          </button>
        </div>
      ))}
      <div class="argrow">
        <input placeholder="name" value={name} onInput={(e) => setName(e.currentTarget.value)} />
        <input placeholder="value" value={value} onInput={(e) => setValue(e.currentTarget.value)} />
        <button
          type="button"
          class="small"
          disabled={name === ''}
          onClick={async () => {
            if (
              await editDraft([{ op: 'setKey', path: ['upstream', index, 'headers', name], value }])
            ) {
              setName('')
              setValue('')
            }
          }}
        >
          Add
        </button>
      </div>
    </div>
  )
}

function SecretBox({ index, upstream }: { index: number; upstream: Table }) {
  const ref = (
    typeof upstream.secret === 'object' && upstream.secret !== null ? upstream.secret : {}
  ) as Table
  const row = secrets.value.find((s) => s.upstream === upstream.id)
  const [value, setValue] = useState('')
  const [result, setResult] = useState<string>()
  const store = async () => {
    try {
      await call('/api/secret', { service: ref.service, username: ref.username, value })
      setValue('')
      setResult('stored')
      await loadSecrets()
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div class="argsbox">
      <strong>secret</strong>{' '}
      {row === undefined ? null : (
        <span class={row.present ? 'ok' : 'bad'}>
          {row.present ? 'present in the keyring' : 'missing from the keyring'}
        </span>
      )}
      <div class="form">
        {(['service', 'username', 'header', 'scheme'] as const).map((k) => (
          <Prop
            key={k}
            table="secret"
            name={k}
            value={ref[k]}
            path={['upstream', index, 'secret', k]}
          />
        ))}
      </div>
      {ref.service === undefined || ref.username === undefined ? null : (
        <div class="argrow">
          <input
            type="password"
            autocomplete="off"
            placeholder="secret value (written to the keyring, never shown again)"
            value={value}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
          <button type="button" class="small" disabled={value === ''} onClick={store}>
            Store
          </button>
          {result === undefined ? null : <span class="muted small-text">{result}</span>}
        </div>
      )}
    </div>
  )
}

function Inventory({ id }: { id: string }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string>()
  const cached = discovery.value.inventories[id] as
    | { ids?: string[]; fetchedAt?: number }
    | undefined
  return (
    <div class="argrow">
      <button
        type="button"
        class="small"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await call('/api/inventory', { upstream: id })
            setMsg(undefined)
            await loadDiscovery()
          } catch (err) {
            setMsg(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        Fetch inventory
      </button>
      <span class="muted small-text">
        {cached?.ids === undefined
          ? 'no cached catalog'
          : `${cached.ids.length} model id(s) cached`}
      </span>
      {msg === undefined ? null : <span class="bad small-text">{msg}</span>}
    </div>
  )
}

function UpstreamCard({ d, upstream, index }: { d: Doc; upstream: Table; index: number }) {
  const id = String(upstream.id)
  const resolve = upstreamResolver(d)
  const used = d.route.filter((r) => resolve(r) === id)
  const addresses = used.flatMap((r) => routeAddress(d, r) ?? [])
  const spend = monthSpend(addresses)
  const cap = typeof upstream.monthly_cap_usd === 'number' ? upstream.monthly_cap_usd : undefined
  return (
    <section class={`panel${upstream.disable === true ? ' off' : ''}`}>
      <div class="rowhead">
        <h3>{id}</h3>
        <span class="muted">{String(upstream.egress ?? 'egress unset')}</span>
        <span class="grow" />
        <CopyButton text={entryToToml('upstream', upstream)} label="Copy TOML" />
        <DeleteGuard doc={d} table="upstream" id={id} index={index} addresses={addresses} />
      </div>
      <div class="form">
        {FIELDS.map((f) => (
          <Prop
            key={f}
            table="upstream"
            name={f}
            value={upstream[f]}
            path={['upstream', index, f]}
          />
        ))}
        <Labeled
          label="spend this month"
          help="From the cost the upstream reported on calls through the routes below."
        >
          <input
            value={cap === undefined ? `$${spend.toFixed(4)}` : `$${spend.toFixed(4)} of $${cap}`}
            disabled={true}
          />
        </Labeled>
      </div>
      <Headers index={index} headers={upstream.headers} />
      <SecretBox index={index} upstream={upstream} />
      <Inventory id={id} />
      <p class="muted small-text">
        Used by {used.length === 0 ? 'no routes' : addresses.join(', ')}
      </p>
    </section>
  )
}

export function UpstreamsView() {
  useEffect(() => {
    void loadSchema()
    void loadSecrets()
    void loadUsage()
    void loadDiscovery()
  }, [])
  const [id, setId] = useState('')
  const parsed = doc.value
  if (parsed === undefined) {
    return <p class="bad">The pending text is not valid TOML; fix it on the Raw TOML view first.</p>
  }
  return (
    <section>
      <h2>Upstreams</h2>
      {parsed.upstream.map((u, i) => (
        <UpstreamCard key={String(u.id)} d={parsed} upstream={u} index={i} />
      ))}
      <div class="panel rowhead">
        <input
          placeholder="new upstream id"
          value={id}
          onInput={(e) => setId(e.currentTarget.value)}
        />
        <button
          type="button"
          disabled={id === ''}
          onClick={async () => {
            if (
              await editDraft([
                {
                  op: 'addEntry',
                  table: 'upstream',
                  entry: { id, egress: id === 'local' ? 'none' : 'remote' },
                },
              ])
            ) {
              setId('')
            }
          }}
        >
          Add upstream
        </button>
      </div>
      <SnippetBox table="upstream" />
    </section>
  )
}
