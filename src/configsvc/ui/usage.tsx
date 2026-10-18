import { useEffect, useState } from 'preact/hooks'
import { fork } from './api.ts'
import { loadUsage, usage } from './data.ts'

interface Total {
  route: string
  requests: number
  failed: number
  cost: number
}

export function UsageView() {
  useEffect(() => {
    fork(loadUsage())
  }, [])
  const [days, setDays] = useState<7 | 31>(7)
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const totals = new Map<string, Total>()
  for (const row of usage.value.filter((r) => r.date >= since)) {
    const t = totals.get(row.route) ?? { route: row.route, requests: 0, failed: 0, cost: 0 }
    t.requests += row.requests
    t.failed += row.failed
    t.cost += row.cost_usd ?? 0
    totals.set(row.route, t)
  }
  const rows = [...totals.values()].sort((a, b) => b.requests - a.requests)
  return (
    <section>
      <fieldset className="seg">
        {([7, 31] as const).map((n) => (
          <button
            key={n}
            type="button"
            className={days === n ? 'on' : ''}
            aria-pressed={days === n}
            onClick={() => setDays(n)}
          >
            Last {n} days
          </button>
        ))}
      </fieldset>
      {rows.length === 0 ? (
        <p className="muted">No calls recorded.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>route</th>
              <th>calls</th>
              <th>failed</th>
              <th>reported cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.route}>
                <td>
                  <code>{t.route}</code>
                </td>
                <td>{t.requests}</td>
                <td className={t.failed > 0 ? 'bad' : ''}>{t.failed}</td>
                <td>{t.cost > 0 ? `$${t.cost.toFixed(4)}` : 'none reported'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
