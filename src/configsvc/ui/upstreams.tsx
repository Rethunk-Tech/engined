import { computed } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { editDraft } from './actions.ts'
import { call, fork } from './api.ts'
import {
  discovery,
  loadDiscovery,
  loadSecrets,
  loadUsage,
  monthSpend,
  plural,
  secrets,
  upstreamResolver,
} from './data.ts'
import { DeleteGuard } from './guardPanel.tsx'
import { type Doc, parseDoc, routeAddress, type Table } from './model.ts'
import { viewParam } from './nav.ts'
import { loadSchema } from './schema.ts'
import { entryToToml } from './snippet.ts'
import { SnippetBox } from './snippets.tsx'
import { draft } from './store.ts'
import { CopyButton, Icon, type IconName, Labeled, Prop } from './widgets.tsx'

const doc = computed(() => parseDoc(draft.value))

const SECTIONS = [
  ['Connection', ['base_url', 'egress', 'wire']],
  ['Inventory', ['inventory_max_age_seconds', 'inventory_refresh_seconds']],
  ['Cost', ['monthly_cap_usd']],
  ['State', ['disable']],
] as const

function Headers({ index, headers }: { index: number; headers: unknown }) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const rows =
    typeof headers === 'object' && headers !== null ? Object.entries(headers as Table) : []
  return (
    <div className="argsbox">
      <span className="section-title">headers</span>
      {rows.map(([k, v]) => (
        <div className="kvrow" key={k}>
          <code>{k}</code>
          <code>{String(v)}</code>
          <button
            type="button"
            className="small"
            onClick={() =>
              fork(
                editDraft([
                  { op: 'setKey', path: ['upstream', index, 'headers', k], value: undefined },
                ]),
              )
            }
          >
            Remove
          </button>
        </div>
      ))}
      <div className="kvrow">
        <input placeholder="name" value={name} onInput={(e) => setName(e.currentTarget.value)} />
        <input placeholder="value" value={value} onInput={(e) => setValue(e.currentTarget.value)} />
        <button
          type="button"
          className="small"
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
  const clear = async () => {
    try {
      await call('/api/secret/clear', { service: ref.service, username: ref.username })
      setResult('cleared')
      await loadSecrets()
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div className="argsbox">
      <span className="section-title">secret</span>{' '}
      {row === undefined ? null : (
        <span className={row.present ? 'ok' : 'bad'}>
          {row.present ? 'present in the keyring' : 'missing from the keyring'}
        </span>
      )}
      <div className="form">
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
        <div className="argrow">
          <input
            type="password"
            autoComplete="off"
            className="secretvalue"
            placeholder="secret value (written to the keyring, never shown again)"
            value={value}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
          <button type="button" className="small" disabled={value === ''} onClick={store}>
            Store
          </button>
          {row?.present === true ? (
            <button type="button" className="small" onClick={() => fork(clear())}>
              Clear
            </button>
          ) : null}
          {result === undefined ? null : <span className="muted small-text">{result}</span>}
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
    <div className="argrow">
      <button
        type="button"
        className="small"
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
      <span className="muted small-text">
        {cached?.ids === undefined
          ? 'no cached catalog'
          : `${plural(cached.ids.length, 'model id')} cached`}
      </span>
      {msg === undefined ? null : <span className="bad small-text">{msg}</span>}
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
    <section className={`panel${upstream.disable === true ? ' off' : ''}`}>
      <div className="rowhead">
        <h3>{id}</h3>
        <EgressIcon egress={upstream.egress} word={true} />
        <span className="grow" />
        <CopyButton text={entryToToml('upstream', upstream)} label="Copy TOML" />
        <DeleteGuard doc={d} table="upstream" id={id} index={index} addresses={addresses} />
      </div>
      {SECTIONS.map(([title, fields]) => (
        <div className="fsect" key={title}>
          <span className="section-title">{title}</span>
          <div className="form">
            {fields.map((f) => (
              <Prop
                key={f}
                table="upstream"
                name={f}
                value={upstream[f]}
                path={['upstream', index, f]}
              />
            ))}
            {title === 'Cost' ? (
              <Labeled
                label="spend this month"
                help="From the cost the upstream reported on calls through the routes below."
              >
                <span className="readout">
                  ${spend.toFixed(2)}
                  {cap === undefined ? null : <span className="muted"> of ${cap}</span>}
                </span>
              </Labeled>
            ) : null}
          </div>
        </div>
      ))}
      <Headers index={index} headers={upstream.headers} />
      <SecretBox index={index} upstream={upstream} />
      <Inventory id={id} />
      {used.length === 0 ? (
        <p className="bad small-text">
          No route uses this upstream, so it serves no models. Give it an engine of kind openai-http
          and a route naming both; <code>model = "*"</code> lists the provider's whole catalog.
        </p>
      ) : (
        <p className="muted small-text">Used by {addresses.join(', ')}</p>
      )}
    </section>
  )
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== 'string' || url === '') {
    return undefined
  }
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const EGRESS_LOOK: Record<string, { icon: IconName; label: string }> = {
  none: { icon: 'home', label: 'egress none: this box only' },
  lan: { icon: 'lan', label: 'egress lan: the local network' },
  remote: { icon: 'globe', label: 'egress remote: the internet' },
}

/** The upstream's egress as an icon, with the word beside it when `word` is set. */
function EgressIcon({ egress, word }: { egress: unknown; word?: boolean }) {
  const look = typeof egress === 'string' ? EGRESS_LOOK[egress] : undefined
  if (look === undefined) {
    return <span className="pill bad">egress unset</span>
  }
  const icon = <Icon name={look.icon} label={look.label} tone="muted" />
  return word === true ? (
    <span className="state muted">
      {icon}
      {String(egress)}
    </span>
  ) : (
    icon
  )
}

/** One upstream in the grid; the card behind it holds the whole form. */
function UpstreamTile({ d, upstream }: { d: Doc; upstream: Table }) {
  const id = String(upstream.id)
  const resolve = upstreamResolver(d)
  const addresses = d.route
    .filter((r) => resolve(r) === id)
    .flatMap((r) => routeAddress(d, r) ?? [])
  const secret = secrets.value.find((s) => s.upstream === id)
  const cap = typeof upstream.monthly_cap_usd === 'number' ? upstream.monthly_cap_usd : undefined
  return (
    <a
      className={`tile panel${upstream.disable === true ? ' off' : ''}`}
      href={`#upstreams/${encodeURIComponent(id)}`}
    >
      <div className="rowhead">
        <h3>{id}</h3>
        {upstream.wire === undefined ? null : <span className="pill">{String(upstream.wire)}</span>}
        <span className="grow" />
        <EgressIcon egress={upstream.egress} />
      </div>
      <code className="muted small-text">{hostOf(upstream.base_url) ?? 'this box'}</code>
      {secret === undefined ? null : (
        <span className={`small-text ${secret.present ? 'ok' : 'bad'}`}>
          {secret.present ? 'secret in the keyring' : 'secret missing from the keyring'}
        </span>
      )}
      {addresses.length === 0 ? (
        <span className="bad small-text">No route uses it, so it serves no models</span>
      ) : null}
      <span className="muted small-text">
        {plural(addresses.length, 'route')} · ${monthSpend(addresses).toFixed(2)}
        {cap === undefined ? '' : ` of $${cap}`} this month
      </span>
    </a>
  )
}

export function UpstreamsView() {
  useEffect(() => {
    fork(loadSchema())
    fork(loadSecrets())
    fork(loadUsage())
    fork(loadDiscovery())
  }, [])
  const [id, setId] = useState('')
  const parsed = doc.value
  if (parsed === undefined) {
    return (
      <p className="bad">The pending text is not valid TOML; fix it on the Raw TOML view first.</p>
    )
  }
  const open = viewParam.value
  if (open !== undefined) {
    const index = parsed.upstream.findIndex((u) => String(u.id) === open)
    const upstream = parsed.upstream[index]
    return (
      <section>
        <a className="back" href="#upstreams">
          ← Upstreams
        </a>
        {upstream === undefined ? (
          <p className="bad">No upstream "{open}" in the pending config.</p>
        ) : (
          <UpstreamCard d={parsed} upstream={upstream} index={index} />
        )}
      </section>
    )
  }
  return (
    <section>
      <div className="tiles">
        {parsed.upstream.map((u) => (
          <UpstreamTile key={String(u.id)} d={parsed} upstream={u} />
        ))}
      </div>
      <div className="panel rowhead">
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
        <button
          type="button"
          onClick={() => {
            location.hash = 'add/provider'
          }}
        >
          Use the Add wizard
        </button>
      </div>
      <SnippetBox table="upstream" />
    </section>
  )
}
