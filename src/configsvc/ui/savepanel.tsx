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

const doc = computed(() => parseDoc(draft.value))

function Conflict() {
  const [diff, setDiff] = useState('')
  useEffect(() => {
    fork(call<{ diff: string }>('/api/diff', { text: draft.value }).then((r) => setDiff(r.diff)))
  }, [])
  return (
    <div className="panel">
      <h3 className="bad">config.toml changed on disk since this page read it</h3>
      <p>
        The diff below goes from what is on disk now to your pending text. Saving anyway replaces
        the on-disk change.
      </p>
      <DiffView diff={diff} />
      <button type="button" onClick={() => fork(discardForDisk())}>
        Reload from disk (drop my edits)
      </button>{' '}
      <button type="button" className="danger" onClick={() => fork(overwriteDisk())}>
        Save mine over it
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
      <h3 className="ok">Saved</h3>
      <p className="muted">
        Changed: {done.changed.length === 0 ? 'nothing' : done.changed.join(', ')}
      </p>
      {done.restart.length === 0 ? (
        <p className="muted">No running engine changes shape.</p>
      ) : (
        <p>
          Engines whose container changes and restarts on their next start:{' '}
          <strong>{done.restart.join(', ')}</strong>
        </p>
      )}
      {done.hard_reload_needed ? (
        <p className="bad">A listen port changed, so only a hard reload applies it.</p>
      ) : null}
      <div className="rowhead">
        <label>
          <input type="radio" checked={mode === 'hot'} onChange={() => setMode('hot')} /> Hot reload
          (keeps containers running)
        </label>
        <label>
          <input type="radio" checked={mode === 'hard'} onChange={() => setMode('hard')} /> Hard
          reload (stops every container)
        </label>
      </div>
      <div className="rowhead">
        <select value={test} onChange={(e) => setTest(e.currentTarget.value)}>
          <option value="">no route test</option>
          {routes.map((a) => (
            <option key={a} value={a}>
              test {a} after reload
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
          <p>
            Keep the saved config as it is, or restore the previous one and reload it the same way?
            Without an answer the change stays.
          </p>
          <button type="button" onClick={keepChange}>
            Keep
          </button>{' '}
          <button type="button" className="danger" onClick={() => fork(revertLastSave())}>
            Revert
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
        <p className="muted">Nothing pending.</p>
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
      {faults.length > 0 ? (
        <span className="muted">
          {' '}
          Fix the errors above first (they are marked on the Raw TOML view).
        </span>
      ) : null}
    </section>
  )
}

function reloadLabel(current: string): string {
  if (current === 'reloading') {
    return 'Reloading…'
  }
  return current === 'verifying' ? 'Waiting for engined…' : 'Reload now'
}
