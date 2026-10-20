/** The Add wizard: a hosted provider, a local engine or a chain, each with every piece it needs to serve. */
import { computed } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import type { Wire } from '../../types.ts'
import { editDraft } from './actions.ts'
import { chainExpansion, expansionText, hopChoices } from './addresses.ts'
import { call, fork } from './api.ts'
import { discovery, loadDiscovery, loadSecrets, plural, upstreamResolver } from './data.ts'
import { ShippedPicker } from './engines.tsx'
import { HopPicker } from './hopPicker.tsx'
import { parseDoc } from './model.ts'
import { viewParam } from './nav.ts'
import { draft } from './store.ts'
import { DiffView, Labeled } from './widgets.tsx'
import { engineFor, freeId, PRESETS, type ProviderPlan, providerOps } from './wizard.ts'

const doc = computed(() => parseDoc(draft.value))

const PATHS = [
  {
    id: 'provider',
    title: 'Connect a provider',
    text: 'A hosted API such as OpenAI or Google AI. engined needs its address, your key, and which of its models to serve; this adds the upstream, the engine and the routes together.',
  },
  {
    id: 'engine',
    title: 'Run a local engine',
    text: 'A model server engined starts on this box: a language model, speech, transcription or images.',
  },
  {
    id: 'chain',
    title: 'Make a chain',
    text: 'One address that tries several models in order, moving on when one fails.',
  },
] as const

const CUSTOM = 'custom'
const MODEL_LIST_SPLIT_RE = /[\s,]+/

/** `#add/<path>/<id>`: the id typed beside the Add box that linked here. */
const PATH_AND_ID_RE = /\/(.*)/s

/** The provider plan as the form edits it; the model list is free text until it becomes the plan. */
type Form = Omit<ProviderPlan, 'models'> & {
  preset: string
  all: boolean
  list: string
  key: string
}

function presetForm(presetId: string, taken: readonly unknown[]): Form {
  const p = PRESETS.find((x) => x.id === presetId)
  const id = freeId(taken, p?.id ?? 'provider')
  return {
    preset: presetId,
    id,
    base_url: p?.base_url ?? '',
    wire: p?.wire ?? 'openai',
    header: p?.header ?? 'authorization',
    scheme: p === undefined ? 'Bearer' : p.scheme,
    service: `${id}-api`,
    username: 'default',
    all: p?.wire !== 'anthropic',
    list: '',
    key: '',
  }
}

function planOf(f: Form): ProviderPlan | undefined {
  const list = f.list
    .split(MODEL_LIST_SPLIT_RE)
    .map((m) => m.trim())
    .filter((m) => m !== '')
  const models = f.all && f.wire === 'openai' ? '*' : list
  if (f.id === '' || f.base_url === '' || f.service === '' || models.length === 0) {
    return
  }
  return {
    id: f.id,
    base_url: f.base_url,
    wire: f.wire,
    header: f.header,
    scheme: f.scheme === '' ? undefined : f.scheme,
    service: f.service,
    username: f.username,
    models,
  }
}

function ProviderPath({ initialId }: { initialId: string }) {
  const d = doc.value
  const taken = d?.upstream.map((u) => u.id) ?? []
  const [f, setF] = useState<Form>(() => {
    const form = presetForm(PRESETS[0]?.id ?? CUSTOM, taken)
    return initialId === '' ? form : { ...form, id: initialId, service: `${initialId}-api` }
  })
  const [preview, setPreview] = useState<{ text: string; diff: string }>()
  const [error, setError] = useState<string>()
  const set = (patch: Partial<Form>) => setF({ ...f, ...patch })
  const plan = planOf(f)
  const clash = taken.includes(f.id)
  useEffect(() => {
    const planned = planOf(f)
    const current = doc.value
    if (
      current === undefined ||
      planned === undefined ||
      current.upstream.some((u) => u.id === f.id)
    ) {
      setPreview(undefined)
      return
    }
    fork(
      call<{ text: string; diff: string }>('/api/edit', {
        text: draft.value,
        ops: providerOps(current, planned),
      })
        .then((r) => {
          setPreview(r)
          setError(undefined)
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))),
    )
  }, [f])
  const apply = async () => {
    if (d === undefined || plan === undefined) {
      return
    }
    try {
      if (f.key !== '') {
        await call('/api/secret', { service: f.service, username: f.username, value: f.key })
        await loadSecrets()
      }
      // Applied to the draft as it is now, not to the text the preview was drawn from.
      if (await editDraft(providerOps(d, plan))) {
        location.hash = 'save'
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <section>
      <div className="panel form">
        <span className="section-title">1. Provider</span>
        <Labeled label="provider">
          <select value={f.preset} onChange={(e) => setF(presetForm(e.currentTarget.value, taken))}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM}>Custom</option>
          </select>
        </Labeled>
        <Labeled
          label="id"
          help="The name this provider goes by in addresses, as @/id/model."
          warn={clash ? `an upstream "${f.id}" already exists` : undefined}
        >
          <input
            value={f.id}
            onInput={(e) => {
              const id = e.currentTarget.value
              set({ id, service: `${id}-api` })
            }}
          />
        </Labeled>
        <Labeled
          label="base_url"
          help="The API's address, up to but not including /chat/completions."
        >
          <input value={f.base_url} onInput={(e) => set({ base_url: e.currentTarget.value })} />
        </Labeled>
        <Labeled
          label="wire"
          help="openai for OpenAI-compatible APIs; anthropic for the Anthropic API, served through the claude CLI."
        >
          <select value={f.wire} onChange={(e) => set({ wire: e.currentTarget.value as Wire })}>
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </select>
        </Labeled>
      </div>
      <div className="panel form">
        <span className="section-title">2. Key</span>
        <Labeled
          label="API key"
          help="Stored in this machine's keyring when you add the provider; never written to config.toml. Leave empty if the keyring already holds it."
        >
          <input
            type="password"
            autoComplete="off"
            value={f.key}
            onInput={(e) => set({ key: e.currentTarget.value })}
          />
        </Labeled>
        <Labeled label="keyring service">
          <input value={f.service} onInput={(e) => set({ service: e.currentTarget.value })} />
        </Labeled>
        <Labeled label="keyring username">
          <input value={f.username} onInput={(e) => set({ username: e.currentTarget.value })} />
        </Labeled>
        <Labeled label="header" help="The request header that carries the key.">
          <input value={f.header} onInput={(e) => set({ header: e.currentTarget.value })} />
        </Labeled>
        <Labeled
          label="scheme"
          help='Put before the key, such as "Bearer"; empty sends the bare key.'
        >
          <input value={f.scheme ?? ''} onInput={(e) => set({ scheme: e.currentTarget.value })} />
        </Labeled>
      </div>
      <div className="panel form">
        <span className="section-title">3. Models</span>
        {f.wire === 'openai' ? (
          <fieldset className="seg">
            {(
              [
                [true, 'All its models'],
                [false, 'Only these'],
              ] as const
            ).map(([all, text]) => (
              <button
                key={text}
                type="button"
                className={f.all === all ? 'on' : ''}
                aria-pressed={f.all === all}
                onClick={() => set({ all })}
              >
                {text}
              </button>
            ))}
          </fieldset>
        ) : null}
        {f.all && f.wire === 'openai' ? (
          <p className="muted small-text">
            Every model the provider lists becomes an address, refreshed hourly from its /models.
          </p>
        ) : (
          <Labeled
            label="model ids"
            help="Exactly as the provider names them, one per line or comma-separated."
          >
            <textarea
              rows={3}
              value={f.list}
              onInput={(e) => set({ list: e.currentTarget.value })}
            />
          </Labeled>
        )}
      </div>
      <div className="panel">
        <span className="section-title">4. Review</span>
        <p className="small-text">
          {plan === undefined
            ? 'Fill in the provider, key name and at least one model.'
            : `This adds the upstream "${plan.id}", serves it through the engine "${engineFor(plan)}"${
                d?.engine.some((e) => e.id === engineFor(plan)) ? ' (already configured)' : ''
              }, and adds ${plan.models === '*' ? 'one route for all its models' : plural(plan.models.length, 'route')}.`}
        </p>
        {error === undefined ? null : <p className="bad">{error}</p>}
        {preview === undefined ? null : <DiffView diff={preview.diff} />}
        <button type="button" className="primary" disabled={preview === undefined} onClick={apply}>
          Add to the pending config
        </button>
      </div>
    </section>
  )
}

function ChainPath({ initialId }: { initialId: string }) {
  const d = doc.value
  const [id, setId] = useState(initialId)
  const [hops, setHops] = useState<string[]>([])
  useEffect(() => {
    fork(loadDiscovery())
  }, [])
  if (d === undefined) {
    return null
  }
  const clash = d.chain.some((c) => c.id === id)
  const upstreamOf = upstreamResolver(d)
  return (
    <section className="panel form">
      <Labeled
        label="id"
        help="Callers name the chain as @/id."
        warn={clash ? `a chain "${id}" already exists` : undefined}
      >
        <input value={id} onInput={(e) => setId(e.currentTarget.value)} />
      </Labeled>
      <div>
        <span className="section-title">hops, tried in this order</span>
        <ol>
          {hops.map((h, i) => {
            const expansion = chainExpansion(d, h, upstreamOf)
            return (
              <li key={h}>
                <span className="hopaddr">
                  <span>
                    <code>{h}</code>{' '}
                    <button
                      type="button"
                      className="small"
                      aria-label={`Remove ${h}`}
                      onClick={() => setHops(hops.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </span>
                  {expansion === undefined ? null : (
                    <span
                      className={expansion.kind === 'cycle' ? 'bad small-text' : 'muted small-text'}
                    >
                      {expansionText(expansion)}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
        <div className="addrow">
          <HopPicker
            choices={hopChoices(d, upstreamOf, discovery.value.inventories)}
            taken={hops}
            onAdd={(added) => setHops([...hops, ...added])}
          />
        </div>
      </div>
      <button
        type="button"
        className="primary"
        disabled={id === '' || clash || hops.length === 0}
        onClick={async () => {
          if (await editDraft([{ op: 'addEntry', table: 'chain', entry: { id, hops } }])) {
            location.hash = 'chains'
          }
        }}
      >
        Add chain
      </button>
    </section>
  )
}

export function AddView() {
  const d = doc.value
  if (d === undefined) {
    return (
      <p className="bad">The pending text is not valid TOML; fix it on the Raw TOML view first.</p>
    )
  }
  const [path, prefill = ''] = (viewParam.value ?? '').split(PATH_AND_ID_RE)
  return (
    <section>
      <div className="tiles">
        {PATHS.map((p) => (
          <a
            key={p.id}
            className={`tile panel${path === p.id ? ' picked' : ''}`}
            href={`#add/${p.id}`}
          >
            <h3>{p.title}</h3>
            <span className="small-text">{p.text}</span>
          </a>
        ))}
      </div>
      {path === 'provider' ? <ProviderPath initialId={prefill} /> : null}
      {path === 'engine' ? (
        <>
          <ShippedPicker d={d} />
          <p className="muted small-text">
            Every engine engined ships is listed until it is in the config. For one it does not
            ship, use Add engine on the Engines view.
          </p>
        </>
      ) : null}
      {path === 'chain' ? <ChainPath initialId={prefill} /> : null}
    </section>
  )
}
