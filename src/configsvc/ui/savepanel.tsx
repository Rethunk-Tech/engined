import { computed } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { call } from './api.ts'
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
import { parseDoc, routeAddress } from './model.ts'
import { dirty, draft, draftDiff, problems } from './store.ts'
import { DiffView, lineKeys } from './widgets.tsx'

const doc = computed(() => parseDoc(draft.value))

function Conflict() {
  const [diff, setDiff] = useState('')
  useEffect(() => {
    void call<{ diff: string }>('/api/diff', { text: draft.value }).then((r) => setDiff(r.diff))
  }, [])
  return (
    <div class="panel">
      <h3 class="bad">config.toml changed on disk since this page read it</h3>
      <p>
        The diff below goes from what is on disk now to your pending text. Saving anyway replaces
        the on-disk change.
      </p>
      <DiffView diff={diff} />
      <button type="button" onClick={() => void discardForDisk()}>
        Reload from disk (drop my edits)
      </button>{' '}
      <button type="button" class="danger" onClick={() => void overwriteDisk()}>
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
    <div class="panel">
      <h3 class="ok">Saved</h3>
      <p class="muted">
        Changed: {done.changed.length === 0 ? 'nothing' : done.changed.join(', ')}
      </p>
      {done.restart.length === 0 ? (
        <p class="muted">No running engine changes shape.</p>
      ) : (
        <p>
          Engines whose container changes and restarts on their next start:{' '}
          <strong>{done.restart.join(', ')}</strong>
        </p>
      )}
      {done.hard_reload_needed ? (
        <p class="bad">A listen port changed, so only a hard reload applies it.</p>
      ) : null}
      <div class="rowhead">
        <label>
          <input type="radio" checked={mode === 'hot'} onChange={() => setMode('hot')} /> Hot reload
          (keeps containers running)
        </label>
        <label>
          <input type="radio" checked={mode === 'hard'} onChange={() => setMode('hard')} /> Hard
          reload (stops every container)
        </label>
      </div>
      <div class="rowhead">
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
          class="primary"
          disabled={busy}
          onClick={() => void reloadDaemon(mode, test === '' ? undefined : test)}
        >
          {phase.value === 'reloading'
            ? 'Reloading…'
            : phase.value === 'verifying'
              ? 'Waiting for engined…'
              : 'Reload now'}
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
        <div class="panel guard">
          <strong class="bad">{keepOrRevert.value.problem}</strong>
          <p>
            Keep the saved config as it is, or restore the previous one and reload it the same way?
            Without an answer the change stays.
          </p>
          <button type="button" onClick={keepChange}>
            Keep
          </button>{' '}
          <button type="button" class="danger" onClick={() => void revertLastSave()}>
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
      <h2>Review and save</h2>
      {conflict.value === undefined ? null : <Conflict />}
      <Applied />
      {dirty.value ? <DiffView diff={draftDiff.value} /> : <p class="muted">Nothing pending.</p>}
      {faults.map((p) => (
        <p class="bad" key={p.message}>
          {p.message}
        </p>
      ))}
      <button
        type="button"
        class="primary"
        disabled={!dirty.value || faults.length > 0 || phase.value !== 'idle'}
        onClick={() => void saveDraft()}
      >
        {phase.value === 'saving' ? 'Saving…' : 'Save config.toml'}
      </button>
      {faults.length > 0 ? (
        <span class="muted">
          {' '}
          Fix the errors above first (they are marked on the Raw TOML view).
        </span>
      ) : null}
    </section>
  )
}
