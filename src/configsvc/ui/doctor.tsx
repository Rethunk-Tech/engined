import { signal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { call } from './api.ts'
import type { DoctorCheck } from './starter.ts'
import { CopyButton } from './widgets.tsx'

export const report = signal<{ ok: boolean; checks: DoctorCheck[] } | undefined>()

export async function runDoctor(): Promise<void> {
  report.value = undefined
  report.value = await call<{ ok: boolean; checks: DoctorCheck[] }>('/api/doctor').catch(() => ({
    ok: false,
    checks: [{ id: 'doctor', ok: false, detail: 'the host report could not be produced' }],
  }))
}

export function summary(checks: readonly DoctorCheck[]): string {
  const failed = checks.filter((c) => !(c.ok || c.skipped)).length
  const skipped = checks.filter((c) => c.skipped).length
  const passed = checks.length - failed - skipped
  return `${passed} passed · ${failed} failed · ${skipped} skipped`
}

function summaryTone(checks: readonly DoctorCheck[]): string {
  return checks.some((c) => !(c.ok || c.skipped)) ? 'bad' : 'ok'
}

export function DoctorView() {
  useEffect(() => {
    void runDoctor()
  }, [])
  const current = report.value
  return (
    <section>
      <h2>Host checks</h2>
      <div class="rowhead">
        {current === undefined ? null : (
          <span class={summaryTone(current.checks)}>{summary(current.checks)}</span>
        )}
        <button type="button" class="small" onClick={() => void runDoctor()}>
          Run again
        </button>
      </div>
      {current === undefined ? (
        <p class="muted">Checking…</p>
      ) : current.checks.length === 0 ? (
        <p class="muted">The host report came back with no checks.</p>
      ) : (
        <table class="grid">
          <tbody>
            {current.checks.map((c) => (
              <tr key={c.id}>
                <td class={c.skipped ? 'muted' : c.ok ? 'ok' : 'bad'}>
                  {c.skipped ? 'skipped' : c.ok ? 'pass' : 'fail'}
                </td>
                <td>
                  <code>{c.id}</code>
                </td>
                <td>{c.detail}</td>
                <td>
                  {c.fix === undefined ? null : (
                    <>
                      <span class="muted">{c.fix}</span> <CopyButton text={c.fix} />
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
