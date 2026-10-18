import { useEffect, useState } from 'preact/hooks'
import { call, fork } from './api.ts'
import { restoreEntry } from './apply.ts'
import { dirty } from './store.ts'
import { DiffView } from './widgets.tsx'

interface Entry {
  name: string
  bytes: number
  modified: string
}

export function HistoryView() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [shown, setShown] = useState<{ name: string; diff: string }>()
  const [confirm, setConfirm] = useState<string>()
  useEffect(() => {
    fork(
      call<{ entries: Entry[] }>('/api/history')
        .then((r) => setEntries(r.entries))
        .catch(() => setEntries([])),
    )
  }, [])
  const diffAgainstCurrent = async (name: string) => {
    const old = await call<{ text: string }>(`/api/history/${encodeURIComponent(name)}`)
    const { diff } = await call<{ diff: string }>('/api/diff', { text: old.text })
    setShown({ name, diff: diff === '' ? '(identical to the current file)' : diff })
  }
  const restore = async (name: string) => {
    if (await restoreEntry(name)) {
      location.hash = 'save'
    }
  }
  return (
    <section>
      <p className="muted">Each save keeps the file it replaced. The newest 20 are kept.</p>
      {entries.length === 0 ? (
        <p className="muted">No previous saves.</p>
      ) : (
        <table className="grid">
          <tbody>
            {entries.map((e) => (
              <tr key={e.name}>
                <td>{new Date(e.modified).toLocaleString()}</td>
                <td className="muted">{e.bytes} B</td>
                <td>
                  <button
                    type="button"
                    className="small"
                    onClick={() => fork(diffAgainstCurrent(e.name))}
                  >
                    Diff against current
                  </button>{' '}
                  {confirm === e.name || !dirty.value ? (
                    <button type="button" className="small" onClick={() => fork(restore(e.name))}>
                      {dirty.value ? 'Restore and drop pending edits' : 'Restore'}
                    </button>
                  ) : (
                    <button type="button" className="small" onClick={() => setConfirm(e.name)}>
                      Restore…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {shown === undefined ? null : (
        <>
          <h3>{shown.name} to current</h3>
          <p className="muted">
            Lines marked + exist in the current file; - are in this version only.
          </p>
          <DiffView diff={shown.diff} />
        </>
      )}
    </section>
  )
}
