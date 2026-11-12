import { useEffect, useState } from 'preact/hooks'
import { fork } from './api.ts'
import { loadUsage, usage } from './data.ts'

const WEEK = 7
const MONTH = 31
const DAY_MS = 86_400_000
const COST_DIGITS = 4
const REPORTED_COST = 'reported cost'
const FAILED = 'failed'
const CALLS = 'calls'
const ROUTE = 'route'
const NO_CALLS_RECORDED = 'No calls recorded.'
const DAYS = ' days'
const LAST = 'Last '

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
  const [days, setDays] = useState<typeof WEEK | typeof MONTH>(WEEK)
  const since = new Date(Date.now() - (days - 1) * DAY_MS).toISOString().slice(0, 10)
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
        {([WEEK, MONTH] as const).map((n) => (
          <button
            key={n}
            type="button"
            className={days === n ? 'on' : ''}
            aria-pressed={days === n}
            onClick={() => setDays(n)}
          >
            {LAST}
            {n}
            {DAYS}
          </button>
        ))}
      </fieldset>
      {rows.length === 0 ? (
        <p className="muted">{NO_CALLS_RECORDED}</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>{ROUTE}</th>
              <th>{CALLS}</th>
              <th>{FAILED}</th>
              <th>{REPORTED_COST}</th>
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
                <td>{t.cost > 0 ? `$${t.cost.toFixed(COST_DIGITS)}` : 'none reported'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
