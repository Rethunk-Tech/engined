import { computed, effect } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import example from '../../../config.example.toml'
import type { ShippedEngine } from '../../configsvcShipped.ts'
import { engineMemory, estimateResidentBytes, memoryVerdict } from '../../memoryEstimate.ts'
import type { EngineKind } from '../../types.ts'
import { ARTIFACT_MISSING, KIND_LABELS, KIND_TRAITS } from '../../types.ts'
import { editDraft } from './actions.ts'
import { call, fork } from './api.ts'
import { ArgsEditor } from './args.tsx'
import { suggestArgKeys } from './argsRules.ts'
import {
  boxMemory,
  callsFor,
  ensureSpec,
  forgetSpec,
  type LiveEngine,
  liveEngines,
  loadDiscovery,
  loadModelFiles,
  loadUsage,
  modelFiles,
  plural,
  specs,
  watchEngines,
} from './data.ts'
import { DeleteGuard } from './guardPanel.tsx'
import {
  type Doc,
  engineKind,
  engineTrait,
  parseDoc,
  routeAddress,
  routesOf,
  type Table,
} from './model.ts'
import { viewParam } from './nav.ts'
import { cacheTypesOf, ctxSizeOf } from './routeRules.ts'
import { type EngineCtx, RouteCard } from './routes.tsx'
import { loadSchema } from './schema.ts'
import { entryToToml } from './snippet.ts'
import { SnippetBox } from './snippets.tsx'
import { postStream } from './sse.ts'
import { engineOps, LOCAL_UPSTREAM_OP } from './starter.ts'
import { draft, status } from './store.ts'
import { findModelFile, formatBytes } from './suggest.ts'
import { About, CopyButton, Icon, type IconName, KindPill, Labeled, Prop } from './widgets.tsx'

const doc = computed(() => parseDoc(draft.value))

const ENGINE_FIELDS = [
  'models_dir',
  'models_max',
  'idle_stop_seconds',
  'drain_timeout_seconds',
  'ready_timeout_s',
  'agent_version',
  'default_model',
  'model_refresh_seconds',
  'spec_dir',
] as const

const STATE_LOOK: Record<string, { icon: IconName; tone: string }> = {
  running: { icon: 'running', tone: 'ok' },
  installed: { icon: 'installed', tone: 'ready' },
  warming: { icon: 'warming', tone: 'warn' },
  unavailable: { icon: 'unavailable', tone: 'bad' },
  disabled: { icon: 'disabled', tone: 'muted' },
}
const STATE_ICON_PX = 18

function liveOf(id: string): LiveEngine | undefined {
  return (
    liveEngines.value[id] ??
    (status.value?.engines as LiveEngine[] | undefined)?.find((e) => e.id === id)
  )
}

function stateOf(id: string, disabled: boolean): string {
  const live = liveOf(id)
  return disabled || live?.disabled === true ? 'disabled' : (live?.state ?? 'unknown')
}

/** The engine's state as an icon, with the word beside it when `word` is set. */
function StateBadge({ id, disabled, word }: { id: string; disabled: boolean; word?: boolean }) {
  const state = stateOf(id, disabled)
  const look = STATE_LOOK[state] ?? { icon: 'installed', tone: 'muted' }
  const icon = <Icon name={look.icon} label={state} tone={look.tone} size={STATE_ICON_PX} />
  return word === true ? (
    <span className={`state ${look.tone}`}>
      {icon}
      {state}
    </span>
  ) : (
    icon
  )
}

function Rename({ engine }: { engine: Table }) {
  const id = String(engine.id)
  const [name, setName] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const apply = async (event: Event) => {
    event.preventDefault()
    if (
      name !== '' &&
      name !== id &&
      (await editDraft([{ op: 'renameId', table: 'engine', oldId: id, newId: name }]))
    ) {
      forgetSpec(id)
      dialog.current?.close()
    }
  }
  return (
    <>
      <button
        type="button"
        className="small"
        onClick={() => {
          setName(id)
          dialog.current?.showModal()
        }}
      >
        Rename
      </button>
      <dialog ref={dialog} className="guard panel">
        <form onSubmit={apply}>
          <label className="field">
            <span className="fieldname">Rename engine "{id}"</span>
            <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
          </label>
          <p className="muted small-text">Routes and chains that name it are updated with it.</p>
          <button type="submit" className="primary" disabled={name === '' || name === id}>
            Rename
          </button>{' '}
          <button type="button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
        </form>
      </dialog>
    </>
  )
}

type Panel = 'logs' | 'resources' | 'spec' | 'obtain'

const LOG_POLL_MS = 2000
/** Within this many pixels of the end counts as reading the end, so new lines keep it in view. */
const LOG_STICK_PX = 24

function Extras({ id, panel, spec }: { id: string; panel: Panel; spec: string | undefined }) {
  const [text, setText] = useState('')
  const pre = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    if (stick.current && pre.current !== null) {
      pre.current.scrollTop = pre.current.scrollHeight
    }
  })
  useEffect(() => {
    setText('')
    stick.current = true
    if (panel === 'logs') {
      const load = () =>
        call<{ lines: string[] }>(`/api/logs/${encodeURIComponent(id)}?tail=200`)
          .then((r) => setText(r.lines.join('\n')))
          .catch((e: unknown) => setText(e instanceof Error ? e.message : String(e)))
      fork(load())
      const timer = setInterval(() => fork(load()), LOG_POLL_MS)
      return () => clearInterval(timer)
    }
    if (panel === 'resources') {
      fork(
        call<unknown>(`/api/resources/${encodeURIComponent(id)}`)
          .then((r) => setText(JSON.stringify(r, null, 2)))
          .catch((e: unknown) => setText(e instanceof Error ? e.message : String(e))),
      )
    } else if (panel === 'obtain') {
      fork(
        postStream(`/api/obtain/${encodeURIComponent(id)}`, (frame) => {
          const d = frame.data as {
            line?: string
            command?: string
            exitCode?: number
            error?: { message?: string }
          }
          const line =
            frame.event === 'line'
              ? d.line
              : frame.event === 'step'
                ? `$ ${d.command}`
                : frame.event === 'exit'
                  ? `exit ${d.exitCode}`
                  : d.error?.message
          setText((t) => `${t}${line ?? ''}\n`)
        }),
      )
    }
    return
  }, [id, panel])
  return (
    <pre
      ref={pre}
      className="log"
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < LOG_STICK_PX
      }}
    >
      {`${panel === 'spec' ? (spec === undefined || spec === '' ? 'no spec.toml' : spec) : text}`}
    </pre>
  )
}

function MemoryLine({ d, engine }: { d: Doc; engine: Table }) {
  const files = modelFiles.value.find((f) => f.engine === engine.id)?.files
  const box = boxMemory.value
  if (files === undefined || box === undefined) {
    return null
  }
  const sized = routesOf(d, String(engine.id)).flatMap(({ route }) => {
    const file = findModelFile(files, route.filename)
    if (file?.gguf === undefined || route.disable === true) {
      return []
    }
    const cache = cacheTypesOf(route, engine)
    const { bytes } = estimateResidentBytes(file, ctxSizeOf(route, engine), cache.k, cache.v)
    return [{ resident: route.keep_resident === true, bytes }]
  })
  if (sized.length === 0) {
    return null
  }
  const mem = engineMemory(sized)
  const verdict = memoryVerdict(mem.resident + mem.largestOnDemand, box)
  return (
    <p className={`small-text${verdict?.level === 'bad' ? ' bad' : ''}`}>
      resident: {formatBytes(mem.resident)} (keep_resident routes) · largest on-demand:{' '}
      {formatBytes(mem.largestOnDemand)} · box: {formatBytes(box.total)} total,{' '}
      {formatBytes(box.available)} available now
      {verdict === undefined ? null : ` · ${verdict.text}`}
    </p>
  )
}

/** Past this many routes an engine card gets a filter box. */
const ROUTE_FILTER_MIN = 8

function EngineCard(props: { d: Doc; engine: Table; index: number; initialPanel?: Panel }) {
  const { d, engine, index } = props
  const id = String(engine.id)
  const [panel, setPanel] = useState<Panel | undefined>(props.initialPanel)
  const entry = specs.value[id]
  const kind = engineKind(engine, entry?.info)
  const ctx: EngineCtx = {
    doc: d,
    engine,
    kind,
    trait: engineTrait(engine, entry?.info),
    spec: entry,
  }
  const routes = routesOf(d, id)
  const addresses = routes.flatMap((r) => routeAddress(d, r.route) ?? [])
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown =
    needle === ''
      ? routes
      : routes.filter((r) =>
          [routeAddress(d, r.route), r.route.model, r.route.display_name].some(
            (v) => typeof v === 'string' && v.toLowerCase().includes(needle),
          ),
        )
  const toggle = (p: Panel) => setPanel(panel === p ? undefined : p)
  return (
    <section className={`engine panel${engine.disable === true ? ' off' : ''}`}>
      <div className="rowhead">
        <h3>{id}</h3>
        <KindPill kind={kind} />
        <StateBadge id={id} disabled={engine.disable === true} word={true} />
        <span className="grow" />
        <span className="group">
          <button
            type="button"
            className="small"
            onClick={() =>
              fork(
                editDraft([
                  {
                    op: 'setKey',
                    path: ['engine', index, 'disable'],
                    value: engine.disable === true ? undefined : true,
                  },
                ]),
              )
            }
          >
            {engine.disable === true ? 'Enable' : 'Disable'}
          </button>
          <CopyButton text={entryToToml('engine', engine)} label="Copy TOML" />
          <Rename engine={engine} />
        </span>
        <DeleteGuard doc={d} table="engine" id={id} index={index} addresses={addresses} />
      </div>
      <About info={entry?.info} />
      <MemoryLine d={d} engine={engine} />
      {liveEngines.value[id]?.last_error ? (
        <p className="bad small-text">{liveEngines.value[id]?.last_error}</p>
      ) : null}
      {liveEngines.value[id]?.fix &&
      !(engine.disable === true || liveEngines.value[id]?.disabled) ? (
        <p className="muted small-text">
          fix: <code>{liveEngines.value[id]?.fix}</code>
        </p>
      ) : null}
      <div className="group">
        {(['logs', 'resources', 'spec'] as const).map((p) => (
          <button key={p} type="button" className="small" onClick={() => toggle(p)}>
            {p === 'spec' ? 'spec.toml' : p === 'logs' ? 'logs' : 'resources'}
          </button>
        ))}
        {entry?.info.artifacts ? (
          <button type="button" className="small" onClick={() => toggle('obtain')}>
            Obtain
          </button>
        ) : null}
      </div>
      {panel === undefined ? null : <Extras id={id} panel={panel} spec={entry?.text} />}
      <details>
        <summary>Engine settings</summary>
        <div className="form">
          {entry === null || entry === undefined ? (
            <Labeled
              label="kind"
              help="For an engine with no spec directory: which built-in spec it takes."
            >
              <select
                value={String(engine.kind ?? '')}
                onChange={(e) =>
                  fork(
                    editDraft([
                      {
                        op: 'setKey',
                        path: ['engine', index, 'kind'],
                        value: e.currentTarget.value || undefined,
                      },
                    ]),
                  )
                }
              >
                <option value="">(none)</option>
                {Object.keys(KIND_TRAITS).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Labeled>
          ) : null}
          {ENGINE_FIELDS.filter((f) => f !== 'agent_version' || kind === 'agentic-cli').map((f) => (
            <Prop key={f} table="engine" name={f} value={engine[f]} path={['engine', index, f]} />
          ))}
          <div className="argsbox">
            <span className="section-title">args</span>
            <ArgsEditor
              args={engine.args}
              path={['engine', index, 'args']}
              scope={{ site: 'engine', kind }}
              suggestions={suggestArgKeys(
                entry === null || entry === undefined ? undefined : { args: entry.info.args },
                example as Table,
                Object.keys((engine.args as Table | undefined) ?? {}),
              )}
            />
          </div>
        </div>
      </details>
      <div
        className="routes"
        style={`--addr-w: ${Math.max(0, ...addresses.map((a) => a.length))}ch`}
      >
        {routes.length > ROUTE_FILTER_MIN ? (
          <div className="rowhead">
            <input
              type="search"
              placeholder="filter routes by address, model or name"
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <span className="muted small-text">
              {shown.length} of {routes.length}
            </span>
          </div>
        ) : null}
        {shown.map((r) => (
          <RouteCard key={r.index} ctx={ctx} entry={r} />
        ))}
        <button
          type="button"
          className="small"
          onClick={() =>
            fork(editDraft([{ op: 'addEntry', table: 'route', entry: { engine: id } }]))
          }
        >
          Add route
        </button>
      </div>
    </section>
  )
}

const TILE_ROUTES = 4
/** Appended to an engine's detail link to open it with the Obtain panel running. */
const OBTAIN_SUFFIX = '/obtain'

/** One engine in the grid: enough to find it and see its health; the card behind it edits. */
function EngineTile({ d, engine }: { d: Doc; engine: Table }) {
  const id = String(engine.id)
  const info = specs.value[id]?.info
  const kind = engineKind(engine, info)
  const addresses = routesOf(d, id).flatMap((r) => routeAddress(d, r.route) ?? [])
  const live = liveOf(id)
  const disabled = engine.disable === true || live?.disabled === true
  const weightsMissing = !disabled && live?.last_error?.includes(ARTIFACT_MISSING) === true
  const fix = disabled || weightsMissing ? undefined : (live?.fix ?? live?.last_error)
  const calls = addresses.reduce((sum, a) => sum + callsFor(a), 0)
  return (
    <a
      className={`tile panel edge-${stateOf(id, disabled)}${disabled ? ' off' : ''}`}
      href={`#engines/${encodeURIComponent(id)}${weightsMissing ? OBTAIN_SUFFIX : ''}`}
    >
      <div className="rowhead">
        <h3>{id}</h3>
        <KindPill kind={kind} />
        <span className="grow" />
        <StateBadge id={id} disabled={disabled} />
      </div>
      {info?.description === undefined ? null : (
        <span className="small-text clamp">{info.description}</span>
      )}
      {weightsMissing ? <span className="bad small-text">weights missing · Obtain</span> : null}
      {fix === undefined ? null : <span className="muted small-text clamp">{fix}</span>}
      <ul className="tile-list">
        {addresses.slice(0, TILE_ROUTES).map((a) => (
          <li key={a}>
            <code>{a}</code>
          </li>
        ))}
        {addresses.length > TILE_ROUTES ? (
          <li className="muted small-text">+{addresses.length - TILE_ROUTES} more</li>
        ) : null}
      </ul>
      <span className="muted small-text">
        {plural(addresses.length, 'route')} · {calls === 0 ? 'no calls' : plural(calls, 'call')} in
        7 days
      </span>
    </a>
  )
}

/** The shipped engines this config does not run yet, each addable as the starter would add it. */
export function ShippedPicker({ d }: { d: Doc }) {
  const [shipped, setShipped] = useState<ShippedEngine[]>([])
  useEffect(() => {
    fork(
      call<{ engines: ShippedEngine[] }>('/api/shipped')
        .then((r) => setShipped(r.engines))
        .catch(() => setShipped([])),
    )
  }, [])
  const have = new Set(d.engine.map((e) => String(e.id)))
  const missing = shipped.filter((e) => !have.has(e.id))
  if (missing.length === 0) {
    return null
  }
  const hasLocal = d.upstream.some((u) => u.id === 'local')
  return (
    <div className="panel">
      <h3>Shipped engines not in this config</h3>
      {missing.map((e) => (
        <div key={e.id}>
          <div className="rowhead">
            <strong>{e.id}</strong>
            <KindPill kind={e.kind} />
            <span className="grow" />
            <button
              type="button"
              className="small"
              onClick={() =>
                fork(editDraft([...(hasLocal ? [] : [LOCAL_UPSTREAM_OP]), ...engineOps(e)]))
              }
            >
              Add
            </button>
          </div>
          <About info={e} />
        </div>
      ))}
    </div>
  )
}

function AddEngine() {
  const [id, setId] = useState('')
  const [kind, setKind] = useState('')
  return (
    <div className="panel rowhead">
      <input placeholder="new engine id" value={id} onInput={(e) => setId(e.currentTarget.value)} />
      <select value={kind} onChange={(e) => setKind(e.currentTarget.value)}>
        <option value="">(spec in engines/{id || 'id'}/)</option>
        {(Object.keys(KIND_TRAITS) as EngineKind[]).map((k) => (
          <option key={k} value={k}>
            {KIND_LABELS[k]} ({k})
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={id === ''}
        onClick={async () => {
          if (
            await editDraft([
              { op: 'addEntry', table: 'engine', entry: kind === '' ? { id } : { id, kind } },
            ])
          ) {
            setId('')
          }
        }}
      >
        Add engine
      </button>
      <button
        type="button"
        onClick={() => {
          location.hash = 'add/engine'
        }}
      >
        Use the Add wizard
      </button>
    </div>
  )
}

export function EnginesView() {
  useEffect(() => {
    fork(loadSchema())
    fork(loadModelFiles())
    fork(loadUsage())
    fork(loadDiscovery())
    const stopWatching = watchEngines()
    const stopSpecs = effect(() => {
      for (const e of doc.value?.engine ?? []) {
        fork(ensureSpec(String(e.id)))
      }
    })
    return () => {
      stopWatching()
      stopSpecs()
    }
  }, [])
  const parsed = doc.value
  if (parsed === undefined) {
    return (
      <p className="bad">The pending text is not valid TOML; fix it on the Raw TOML view first.</p>
    )
  }
  const param = viewParam.value
  if (param !== undefined) {
    const obtain = param.endsWith(OBTAIN_SUFFIX)
    const open = obtain ? param.slice(0, -OBTAIN_SUFFIX.length) : param
    const index = parsed.engine.findIndex((e) => String(e.id) === open)
    const engine = parsed.engine[index]
    return (
      <section>
        <a className="back" href="#engines">
          ← Engines
        </a>
        {engine === undefined ? (
          <p className="bad">No engine "{open}" in the pending config.</p>
        ) : (
          <EngineCard
            d={parsed}
            engine={engine}
            index={index}
            initialPanel={obtain ? 'obtain' : undefined}
          />
        )}
      </section>
    )
  }
  return (
    <section>
      <div className="tiles">
        {parsed.engine.map((engine) => (
          <EngineTile key={String(engine.id)} d={parsed} engine={engine} />
        ))}
      </div>
      <ShippedPicker d={parsed} />
      <AddEngine />
      <SnippetBox table="engine" />
      <SnippetBox table="route" />
    </section>
  )
}
