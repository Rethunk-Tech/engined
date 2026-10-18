import { useEffect } from 'preact/hooks'
import { fork } from './api.ts'
import { report, runDoctor, summary } from './data.ts'
import { CopyButton } from './widgets.tsx'

function summaryTone(checks: readonly { ok?: boolean; skipped?: boolean }[]): string {
  return checks.some((c) => !(c.ok || c.skipped)) ? 'bad' : 'ok'
}

export function DoctorView() {
  useEffect(() => {
    fork(runDoctor())
  }, [])
  const current = report.value
  return (
    <section>
      <div className="rowhead">
        {current === undefined ? null : (
          <span className={summaryTone(current.checks)}>{summary(current.checks)}</span>
        )}
        <button type="button" className="small" onClick={() => fork(runDoctor())}>
          Run again
        </button>
      </div>
      {current === undefined ? (
        <p className="muted">Checking…</p>
      ) : current.checks.length === 0 ? (
        <p className="muted">The host report came back with no checks.</p>
      ) : (
        <table className="grid">
          <tbody>
            {current.checks.map((c) => (
              <tr key={c.id}>
                <td className={c.skipped ? 'muted' : c.ok ? 'ok' : 'bad'}>
                  {c.skipped ? 'skipped' : c.ok ? 'pass' : 'fail'}
                </td>
                <td>
                  <code>{c.id}</code>
                </td>
                <td>{c.detail}</td>
                <td>
                  {c.fix === undefined ? null : (
                    <>
                      <span className="muted">{c.fix}</span> <CopyButton text={c.fix} />
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
