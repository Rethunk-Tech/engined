import { computed } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { addressBook } from './addresses.ts'
import { callsFor, ensureSpec, loadUsage, upstreamResolver } from './data.ts'
import { parseDoc } from './model.ts'
import { draft } from './store.ts'
import { CopyButton } from './widgets.tsx'

const doc = computed(() => parseDoc(draft.value))

export function AddressBookView() {
  useEffect(() => {
    void loadUsage()
    for (const e of doc.value?.engine ?? []) {
      void ensureSpec(String(e.id))
    }
  }, [])
  const parsed = doc.value
  if (parsed === undefined) {
    return <p class="bad">The pending text is not valid TOML; fix it on the Raw TOML view first.</p>
  }
  const rows = addressBook(parsed, upstreamResolver(parsed))
  return (
    <section>
      <p class="muted">
        What a consumer puts in <code>model</code>. Calls are the last 7 days.
      </p>
      <table class="grid">
        <thead>
          <tr>
            <th>address</th>
            <th>kind</th>
            <th>calls</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.address} class={row.disabled ? 'off' : ''}>
              <td>
                <code>{row.address}</code>
              </td>
              <td class="muted">{row.disabled ? `${row.kind} (disabled)` : row.kind}</td>
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
