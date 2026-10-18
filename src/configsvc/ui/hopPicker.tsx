import { useRef, useState } from 'preact/hooks'

/** Catalogs run to thousands of ids; rendering them all as checkboxes stalls the dialog. */
const SHOWN = 200

/**
 * Adds hops to a chain: filter the choices, tick any number, add them in the order ticked.
 * Hops the chain already has are not offered again. `blocked` rows stay visible with their
 * reason and cannot be ticked: choosing one would close a cycle.
 */
export function HopPicker(props: {
  choices: string[]
  taken: string[]
  blocked?: ReadonlyMap<string, string>
  onAdd: (hops: string[]) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const taken = new Set(props.taken)
  const blocked = props.blocked ?? new Map<string, string>()
  const words = filter
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '')
  const matches = props.choices.filter((a) => {
    const lower = a.toLowerCase()
    return !taken.has(a) && words.every((w) => lower.includes(w))
  })
  const visible = matches.slice(0, SHOWN)
  const selectable = visible.filter((a) => !blocked.has(a))
  const offered = matches.filter((a) => !blocked.has(a)).length
  const toggle = (a: string) => {
    if (blocked.has(a)) {
      return
    }
    setPicked(picked.includes(a) ? picked.filter((p) => p !== a) : [...picked, a])
  }
  const selectVisible = () => {
    const next = [...picked]
    for (const a of selectable) {
      if (!next.includes(a)) {
        next.push(a)
      }
    }
    setPicked(next)
  }
  return (
    <>
      <button type="button" class="small" onClick={() => dialog.current?.showModal()}>
        Add hops…
      </button>
      <dialog
        ref={dialog}
        class="guard panel picker"
        onClose={() => {
          setFilter('')
          setPicked([])
        }}
      >
        <input
          placeholder="filter, e.g. claude sonnet"
          value={filter}
          autofocus
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <div class="picklist">
          {visible.map((a) => {
            const n = picked.indexOf(a) + 1
            const reason = blocked.get(a)
            return (
              <label key={a} class="pick">
                <input
                  type="checkbox"
                  checked={n > 0}
                  disabled={reason !== undefined}
                  onChange={() => toggle(a)}
                />
                <span>
                  <code>{a}</code>
                  {reason === undefined ? null : <span class="bad small-text"> {reason}</span>}
                </span>
                <span class="muted">{n > 0 ? `${n}.` : ''}</span>
              </label>
            )
          })}
        </div>
        <p class="muted small-text">
          {matches.length > SHOWN
            ? `Showing ${SHOWN} of ${matches.length}; narrow the filter to see the rest.`
            : `${offered} available.`}{' '}
          Hops are added in the order you tick them.
        </p>
        <button
          type="button"
          disabled={selectable.length === 0 || selectable.every((a) => picked.includes(a))}
          onClick={selectVisible}
        >
          Select all visible
        </button>{' '}
        <button
          type="button"
          class="primary"
          disabled={picked.length === 0}
          onClick={() => {
            props.onAdd(picked)
            dialog.current?.close()
          }}
        >
          Add {picked.length === 1 ? '1 hop' : `${picked.length} hops`}
        </button>{' '}
        <button type="button" onClick={() => dialog.current?.close()}>
          Cancel
        </button>
      </dialog>
    </>
  )
}
