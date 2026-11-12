import { computed } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { addressBook } from './addresses.ts'
import { fork } from './api.ts'
import { callsFor, ensureSpec, loadUsage, upstreamResolver } from './data.ts'
import { parseDoc } from './model.ts'
import { draft } from './store.ts'
import { CopyButton, InvalidToml } from './widgets.tsx'

const ADDRESS_HELP_BEFORE = 'What a consumer puts in '
const MODEL_KEY = 'model'
const ADDRESS_HELP_AFTER = '. Calls are the last 7 days.'
const COL_ADDRESS = 'address'
const COL_KIND = 'kind'
const COL_CALLS = 'calls'

const doc = computed(() => parseDoc(draft.value))

export function AddressBookView() {
  useEffect(() => {
    fork(loadUsage())
    for (const e of doc.value?.engine ?? []) {
      fork(ensureSpec(String(e.id)))
    }
  }, [])
  const parsed = doc.value
  if (parsed === undefined) {
    return <InvalidToml />
  }
  const rows = addressBook(parsed, upstreamResolver(parsed))
  return (
    <section>
      <p className="muted">
        {ADDRESS_HELP_BEFORE}
        <code>{MODEL_KEY}</code>
        {ADDRESS_HELP_AFTER}
      </p>
      <table className="grid">
        <thead>
          <tr>
            <th>{COL_ADDRESS}</th>
            <th>{COL_KIND}</th>
            <th>{COL_CALLS}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.address} className={row.disabled ? 'off' : ''}>
              <td>
                <code>{row.address}</code>
              </td>
              <td className="muted">{row.disabled ? `${row.kind} (disabled)` : row.kind}</td>
              <td>{callsFor(row.address)}</td>
              <td>
                <CopyButton text={row.address} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
