import { computed, effect } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import example from '../../../config.example.toml'
import type { EngineKind } from '../../types.ts'
import { KIND_TRAITS } from '../../types.ts'
import { editDraft } from './actions.ts'
import { call } from './api.ts'
import { ArgsEditor } from './args.tsx'
import { suggestArgKeys } from './argsRules.ts'
import {
  callsFor,
  ensureSpec,
  forgetSpec,
  liveEngines,
  loadDiscovery,
  loadModelFiles,
  loadUsage,
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
import { type EngineCtx, RouteCard } from './routes.tsx'
import { loadSchema } from './schema.ts'
import { entryToToml } from './snippet.ts'
import { SnippetBox } from './snippets.tsx'
import { postStream } from './sse.ts'
import { draft, status } from './store.ts'
import { CopyButton, Labeled, Prop } from './widgets.tsx'

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

function StatePill({ id }: { id: string }) {
  const live =
    liveEngines.value[id] ??
    (status.value?.engines as { id: string; state: string }[] | undefined)?.find((e) => e.id === id)
  const state = live?.state ?? 'unknown'
  const tone = state === 'running' ? 'ok' : state === 'unavailable' ? 'bad' : 'muted'
  return <span class={`pill ${tone}`}>{state}</span>
}

function Rename({ engine }: { engine: Table }) {
  const [name, setName] = useState('')
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button type="button" class="small" onClick={() => setOpen(true)}>
        Rename
      </button>
    )
  }
  return (
    <span class="inline">
      <input
        value={name}
        placeholder={String(engine.id)}
        onInput={(e) => setName(e.currentTarget.value)}
      />
      <button
        type="button"
        class="small"
        disabled={name === '' || name === engine.id}
        onClick={async () => {
          if (
            await editDraft([
              { op: 'renameId', table: 'engine', oldId: String(engine.id), newId: name },
            ])
          ) {
            forgetSpec(String(engine.id))
            setOpen(false)
          }
        }}
      >
        Apply
      </button>
      <button type="button" class="small" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  )
}

type Panel = 'logs' | 'resources' | 'spec' | 'obtain'

function Extras({ id, panel, spec }: { id: string; panel: Panel; spec: string | undefined }) {
  const [text, setText] = useState('')
  useEffect(() => {
    setText('')
    if (panel === 'logs') {
      void call<{ lines: string[] }>(`/api/logs/${encodeURIComponent(id)}?tail=200`)
        .then((r) => setText(r.lines.join('\n')))
        .catch((e: unknown) => setText(String(e)))
    } else if (panel === 'resources') {
      void call<unknown>(`/api/resources/${encodeURIComponent(id)}`)
        .then((r) => setText(JSON.stringify(r, null, 2)))
        .catch((e: unknown) => setText(String(e)))
    } else if (panel === 'obtain') {
      void postStream(`/api/obtain/${encodeURIComponent(id)}`, (frame) => {
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
      })
    }
  }, [id, panel])
  return <pre class="log">{panel === 'spec' ? (spec ?? 'no spec.toml') : text}</pre>
}

function EngineCard({ d, engine, index }: { d: Doc; engine: Table; index: number }) {
  const id = String(engine.id)
  const [panel, setPanel] = useState<Panel | undefined>()
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
  const toggle = (p: Panel) => setPanel(panel === p ? undefined : p)
  return (
    <section class={`engine panel${engine.disable === true ? ' off' : ''}`}>
      <div class="rowhead">
        <h3>{id}</h3>
        <span class="pill">{kind ?? 'unknown kind'}</span>
        <StatePill id={id} />
        <span class="grow" />
        <span class="group">
          <button
            type="button"
            class="small"
            onClick={() =>
              void editDraft([
                {
                  op: 'setKey',
                  path: ['engine', index, 'disable'],
                  value: engine.disable === true ? undefined : true,
                },
              ])
            }
          >
            {engine.disable === true ? 'Enable' : 'Disable'}
          </button>
          <CopyButton text={entryToToml('engine', engine)} label="Copy TOML" />
          <Rename engine={engine} />
        </span>
        <DeleteGuard doc={d} table="engine" id={id} index={index} addresses={addresses} />
      </div>
      {liveEngines.value[id]?.last_error ? (
        <p class="bad small-text">{liveEngines.value[id]?.last_error}</p>
      ) : null}
      {liveEngines.value[id]?.fix ? (
        <p class="muted small-text">
          fix: <code>{liveEngines.value[id]?.fix}</code>
        </p>
      ) : null}
      <div class="group">
        {(['logs', 'resources', 'spec'] as const).map((p) => (
          <button key={p} type="button" class="small" onClick={() => toggle(p)}>
            {p === 'spec' ? 'spec.toml' : p}
          </button>
        ))}
        {entry?.info.artifacts ? (
          <button type="button" class="small" onClick={() => toggle('obtain')}>
            Obtain
          </button>
        ) : null}
      </div>
      {panel === undefined ? null : <Extras id={id} panel={panel} spec={entry?.text} />}
      <details>
        <summary>Engine settings</summary>
        <div class="form">
          {entry === null || entry === undefined ? (
            <Labeled
              label="kind"
              help="For an engine with no spec directory: which built-in spec it takes."
            >
              <select
                value={String(engine.kind ?? '')}
                onChange={(e) =>
                  void editDraft([
                    {
                      op: 'setKey',
                      path: ['engine', index, 'kind'],
                      value: e.currentTarget.value || undefined,
                    },
                  ])
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
          <div class="argsbox">
            <span class="section-title">args</span>
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
      <div class="routes" style={`--addr-w: ${Math.max(0, ...addresses.map((a) => a.length))}ch`}>
        {routes.map((r) => (
          <RouteCard key={r.index} ctx={ctx} entry={r} />
        ))}
        <button
          type="button"
          class="small"
          onClick={() =>
            void editDraft([{ op: 'addEntry', table: 'route', entry: { engine: id } }])
          }
        >
          Add route
        </button>
      </div>
    </section>
  )
}

const TILE_ROUTES = 4

/** One engine in the grid: enough to find it and see its health; the card behind it edits. */
function EngineTile({ d, engine }: { d: Doc; engine: Table }) {
  const id = String(engine.id)
  const kind = engineKind(engine, specs.value[id]?.info)
  const addresses = routesOf(d, id).flatMap((r) => routeAddress(d, r.route) ?? [])
  const fix = liveEngines.value[id]?.fix ?? liveEngines.value[id]?.last_error
  const calls = addresses.reduce((sum, a) => sum + callsFor(a), 0)
  return (
    <a
      class={`tile panel${engine.disable === true ? ' off' : ''}`}
      href={`#engines/${encodeURIComponent(id)}`}
    >
      <div class="rowhead">
        <h3>{id}</h3>
        <span class="pill">{kind ?? 'unknown kind'}</span>
        <StatePill id={id} />
      </div>
      {fix === undefined ? null : <span class="muted small-text clamp">{fix}</span>}
      <ul class="tile-list">
        {addresses.slice(0, TILE_ROUTES).map((a) => (
          <li key={a}>
            <code>{a}</code>
          </li>
        ))}
        {addresses.length > TILE_ROUTES ? (
          <li class="muted small-text">+{addresses.length - TILE_ROUTES} more</li>
        ) : null}
      </ul>
      <span class="muted small-text">
        {addresses.length} route(s) · {calls} call(s) / 7 d
      </span>
    </a>
  )
}

function AddEngine() {
  const [id, setId] = useState('')
  const [kind, setKind] = useState('')
  return (
    <div class="panel rowhead">
      <input placeholder="new engine id" value={id} onInput={(e) => setId(e.currentTarget.value)} />
      <select value={kind} onChange={(e) => setKind(e.currentTarget.value)}>
        <option value="">(spec in engines/{id || 'id'}/)</option>
        {(Object.keys(KIND_TRAITS) as EngineKind[]).map((k) => (
          <option key={k} value={k}>
            kind {k}
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
    </div>
  )
}

export function EnginesView() {
  useEffect(() => {
    void loadSchema()
    void loadModelFiles()
    void loadUsage()
    void loadDiscovery()
    const stopWatching = watchEngines()
    const stopSpecs = effect(() => {
      for (const e of doc.value?.engine ?? []) {
        void ensureSpec(String(e.id))
      }
    })
    return () => {
      stopWatching()
      stopSpecs()
    }
  }, [])
  const parsed = doc.value
  if (parsed === undefined) {
    return <p class="bad">The pending text is not valid TOML; fix it on the Raw TOML view first.</p>
  }
  const open = viewParam.value
  if (open !== undefined) {
    const index = parsed.engine.findIndex((e) => String(e.id) === open)
    const engine = parsed.engine[index]
    return (
      <section>
        <a class="back" href="#engines">
          ← Engines
        </a>
        {engine === undefined ? (
          <p class="bad">No engine "{open}" in the pending config.</p>
        ) : (
          <EngineCard d={parsed} engine={engine} index={index} />
        )}
      </section>
    )
  }
  return (
    <section>
      <div class="tiles">
        {parsed.engine.map((engine) => (
          <EngineTile key={String(engine.id)} d={parsed} engine={engine} />
        ))}
      </div>
      <AddEngine />
      <SnippetBox table="engine" />
      <SnippetBox table="route" />
    </section>
  )
}
