import { computed } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { call, fork } from './api.ts'
import {
  applied,
  applyLog,
  conflict,
  discardForDisk,
  keepChange,
  keepOrRevert,
  overwriteDisk,
  phase,
  reloadDaemon,
  revertLastSave,
  saveDraft,
} from './apply.ts'
import { lineKeys } from './data.ts'
import { parseDoc, routeAddress } from './model.ts'
import { dirty, draft, draftDiff, problems } from './store.ts'
import { DiffView } from './widgets.tsx'

const FIX_THE_ERRORS_ABOVE = 'Fix the errors above first (they are marked on the Raw TOML view).'
const NOTHING_PENDING = 'Nothing pending.'
const REVERT = 'Revert'
const KEEP = 'Keep'
const KEEP_THE_SAVED_CONFIG =
  'Keep the saved config as it is, or restore the previous one and reload it the same way? Without an answer the change stays.'
const AFTER_RELOAD = ' after reload'
const TEST = 'test '
const NO_ROUTE_TEST = 'no route test'
const HARD_RELOAD_STOPS_EVERY = ' Hard reload (stops every container)'
const HOT_RELOAD_KEEPS_CONTAINERS = ' Hot reload (keeps containers running)'
const A_LISTEN_PORT_CHANGED = 'A listen port changed, so only a hard reload applies it.'
const ENGINES_WHOSE_CONTAINER_CHANGES =
  'Engines whose container changes and restarts on their next start:'
const NO_RUNNING_ENGINE_CHANGES = 'No running engine changes shape.'
const CHANGED = 'Changed: '
const SAVED = 'Saved'
const SAVE_MINE_OVER_IT = 'Save mine over it'
const RELOAD_FROM_DISK_DROP = 'Reload from disk (drop my edits)'
const THE_DIFF_BELOW_GOES =
  'The diff below goes from what is on disk now to your pending text. Saving anyway replaces the on-disk change.'
const CONFIG_TOML_CHANGED_ON = 'config.toml changed on disk since this page read it'

const doc = computed(() => parseDoc(draft.value))

function Conflict() {
  const [diff, setDiff] = useState('')
  useEffect(() => {
    fork(call<{ diff: string }>('/api/diff', { text: draft.value }).then((r) => setDiff(r.diff)))
  }, [])
  return (
    <div className="panel">
      <h3 className="bad">{CONFIG_TOML_CHANGED_ON}</h3>
      <p>{THE_DIFF_BELOW_GOES}</p>
      <DiffView diff={diff} />
      <button type="button" onClick={() => fork(discardForDisk())}>
        {RELOAD_FROM_DISK_DROP}
      </button>{' '}
      <button type="button" className="danger" onClick={() => fork(overwriteDisk())}>
        {SAVE_MINE_OVER_IT}
      </button>
    </div>
  )
}

function Applied() {
  const done = applied.value
  const [mode, setMode] = useState<'hot' | 'hard'>(done?.hard_reload_needed ? 'hard' : 'hot')
  const [test, setTest] = useState('')
  if (done === undefined) {
    return null
  }
  const routes = (doc.value?.route ?? []).flatMap((r) => routeAddress(doc.value as never, r) ?? [])
  const busy = phase.value !== 'idle'
  return (
    <div className="panel">
      <h3 className="ok">{SAVED}</h3>
      <p className="muted">
        {CHANGED}
        {done.changed.length === 0 ? 'nothing' : done.changed.join(', ')}
      </p>
      {done.restart.length === 0 ? (
        <p className="muted">{NO_RUNNING_ENGINE_CHANGES}</p>
      ) : (
        <p>
          {ENGINES_WHOSE_CONTAINER_CHANGES} <strong>{done.restart.join(', ')}</strong>
        </p>
      )}
      {done.hard_reload_needed ? <p className="bad">{A_LISTEN_PORT_CHANGED}</p> : null}
      <div className="rowhead">
        <label>
          <input type="radio" checked={mode === 'hot'} onChange={() => setMode('hot')} />
          {HOT_RELOAD_KEEPS_CONTAINERS}
        </label>
        <label>
          <input type="radio" checked={mode === 'hard'} onChange={() => setMode('hard')} />
          {HARD_RELOAD_STOPS_EVERY}
        </label>
      </div>
      <div className="rowhead">
        <select value={test} onChange={(e) => setTest(e.currentTarget.value)}>
          <option value="">{NO_ROUTE_TEST}</option>
          {routes.map((a) => (
            <option key={a} value={a}>
              {TEST}
              {a}
              {AFTER_RELOAD}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => fork(reloadDaemon(mode, test === '' ? undefined : test))}
        >
          {reloadLabel(phase.value)}
        </button>
      </div>
      {applyLog.value.length === 0 ? null : (
        <ul>
          {lineKeys(applyLog.value).map((key, i) => (
            <li key={key}>{applyLog.value[i]}</li>
          ))}
        </ul>
      )}
      {keepOrRevert.value === undefined ? null : (
        <div className="panel guard">
          <strong className="bad">{keepOrRevert.value.problem}</strong>
          <p>{KEEP_THE_SAVED_CONFIG}</p>
          <button type="button" onClick={keepChange}>
            {KEEP}
          </button>{' '}
          <button type="button" className="danger" onClick={() => fork(revertLastSave())}>
            {REVERT}
          </button>
        </div>
      )}
    </div>
  )
}

export function SaveView() {
  const faults = problems.value
  return (
    <section>
      {conflict.value === undefined ? null : <Conflict />}
      <Applied />
      {dirty.value ? (
        <DiffView diff={draftDiff.value} />
      ) : (
        <p className="muted">{NOTHING_PENDING}</p>
      )}
      {faults.map((p) => (
        <p className="bad" key={p.message}>
          {p.message}
        </p>
      ))}
      <button
        type="button"
        className="primary"
        disabled={!dirty.value || faults.length > 0 || phase.value !== 'idle'}
        onClick={() => fork(saveDraft())}
      >
        {phase.value === 'saving' ? 'Saving…' : 'Save config.toml'}
      </button>
      {faults.length > 0 ? <span className="muted"> {FIX_THE_ERRORS_ABOVE}</span> : null}
    </section>
  )
}

function reloadLabel(current: string): string {
  if (current === 'reloading') {
    return 'Reloading…'
  }
  return current === 'verifying' ? 'Waiting for engined…' : 'Reload now'
}
