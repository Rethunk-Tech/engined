import { useEffect, useState } from 'preact/hooks'
import { setDraft } from './actions.ts'
import { call, fork } from './api.ts'
import { report, runDoctor } from './data.ts'
import {
  blockers,
  type Candidate,
  needsWeights,
  type Pick,
  proposedByDefault,
  starterOps,
} from './starter.ts'
import { snapshot } from './store.ts'
import { formatBytes } from './suggest.ts'
import { About, DiffView, KindPill } from './widgets.tsx'

type Chosen = Record<string, { on: boolean; files: Record<string, string> }>

const ROLES = ['chat', 'vision', 'embedding', 'rerank']

function EngineChoice(props: {
  engine: Candidate
  chosen: Chosen[string] | undefined
  change: (next: Chosen[string]) => void
}) {
  const { engine, chosen } = props
  const blocked = blockers(engine, report.value?.checks ?? [])
  const on = chosen?.on ?? false
  const files = chosen?.files ?? {}
  const rolePerFile = engine.kind === 'openai-http'
  const listsFiles = on && engine.models_dir !== undefined
  return (
    <div className="panel">
      <label className="rowhead">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => props.change({ on: e.currentTarget.checked, files })}
        />
        <strong>{engine.id}</strong>
        <KindPill kind={engine.kind} />
      </label>
      <About info={engine} />
      {blocked.map((c) => (
        <p className="bad small-text" key={c.id}>
          {c.id}: {c.detail}
          {c.fix === undefined ? '' : ` (${c.fix})`}
        </p>
      ))}
      {listsFiles && engine.files.length === 0 ? (
        <p className="muted small-text">
          No weights in {engine.models_path} yet, so {engine.id} is left out of the proposal until
          the files are there.
        </p>
      ) : null}
      {listsFiles && engine.files.length > 0 ? (
        <>
          {needsWeights(engine) && Object.keys(files).length === 0 ? (
            <p className="muted small-text">
              Pick at least one weights file; without one, {engine.id} is left out of the proposal.
            </p>
          ) : null}
          {engine.files.map((f) => (
            <div className="argrow" key={f.path}>
              <label>
                <input
                  type="checkbox"
                  checked={f.path in files}
                  onChange={(e) => {
                    const next = { ...files }
                    if (e.currentTarget.checked) {
                      next[f.path] = rolePerFile ? 'chat' : ''
                    } else {
                      delete next[f.path]
                    }
                    props.change({ on, files: next })
                  }}
                />{' '}
                <code>{f.path}</code>
              </label>
              <span className="muted small-text">
                {formatBytes(f.bytes)}
                {f.gguf?.quantization === undefined ? '' : ` · ${f.gguf.quantization}`}
              </span>
              {rolePerFile && f.path in files ? (
                <select
                  value={files[f.path]}
                  onChange={(e) =>
                    props.change({ on, files: { ...files, [f.path]: e.currentTarget.value } })
                  }
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
    </div>
  )
}

export function StarterView() {
  const [engines, setEngines] = useState<Candidate[]>([])
  const [chosen, setChosen] = useState<Chosen>({})
  const [preview, setPreview] = useState<{ text: string; diff: string }>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    fork(runDoctor())
    fork(call<{ engines: Candidate[] }>('/api/shipped').then((r) => setEngines(r.engines)))
  }, [])
  const checks = report.value?.checks
  useEffect(() => {
    if (checks === undefined) {
      return
    }
    setChosen((prev) => {
      const next = { ...prev }
      for (const e of engines) {
        next[e.id] ??= { on: proposedByDefault(e, blockers(e, checks)), files: {} }
      }
      return next
    })
  }, [engines, checks])
  useEffect(() => {
    const picks: Pick[] = engines.flatMap((engine) => {
      const c = chosen[engine.id]
      return c?.on
        ? [
            {
              engine,
              files: Object.entries(c.files).map(([path, role]) => ({
                path,
                role: role || undefined,
              })),
            },
          ]
        : []
    })
    const base = snapshot.value?.text ?? ''
    fork(
      call<{ text: string; diff: string }>('/api/edit', { text: base, ops: starterOps(picks) })
        .then((r) => {
          setPreview(r)
          setError(undefined)
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))),
    )
  }, [engines, chosen])
  return (
    <section>
      <p className="muted">
        There is no config yet. Pick what to run; the proposal below becomes the pending text, which
        you review and save.
      </p>
      {engines.map((e) => (
        <EngineChoice
          key={e.id}
          engine={e}
          chosen={chosen[e.id]}
          change={(next) => setChosen({ ...chosen, [e.id]: next })}
        />
      ))}
      <h3>Proposal</h3>
      {error === undefined ? null : <p className="bad">{error}</p>}
      {preview === undefined ? null : <DiffView diff={preview.diff} />}
      <button
        type="button"
        className="primary"
        disabled={preview === undefined}
        onClick={() => {
          if (preview !== undefined) {
            setDraft(preview.text)
            location.hash = 'save'
          }
        }}
      >
        Use this proposal
      </button>
    </section>
  )
}
