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
import { type EngineCtx, RouteCard } from './routes.tsx'
import { loadSchema } from './schema.ts'
import { postStream } from './sse.ts'
import { draft, status } from './store.ts'
import { Labeled, Prop } from './widgets.tsx'

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
        <Rename engine={engine} />
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
      <div class="rowhead">
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
            <strong>args</strong>
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
      <div class="routes">
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
  return (
    <section>
      <h2>Engines</h2>
      {parsed.engine.map((engine, index) => (
        <EngineCard key={String(engine.id)} d={parsed} engine={engine} index={index} />
      ))}
      <AddEngine />
    </section>
  )
}
