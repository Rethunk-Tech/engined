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

export function DoctorView() {
  useEffect(() => {
    void runDoctor()
  }, [])
  const current = report.value
  return (
    <section>
      <h2>Host checks</h2>
      <button type="button" onClick={() => void runDoctor()}>
        Run again
      </button>
      {current === undefined ? (
        <p class="muted">Checking…</p>
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
