import { useEffect, useRef, useState } from 'preact/hooks'
import { editDraft } from './actions.ts'
import { call } from './api.ts'
import { callsFor, plural } from './data.ts'
import { removalOps } from './guard.ts'
import type { Doc } from './model.ts'
import { draft } from './store.ts'

const CANCEL = 'Cancel'
const STILL_REFERENCED_BY = 'Still referenced by:'
const NOTHING_ELSE_POINTS_AT = 'Nothing else points at it.'
const SEPARATOR = '.'
const IN_THE_LAST_7 = ' in the last 7 days across'
const SEPARATOR_2 = '"?'
const SEPARATOR_3 = ' "'
const DELETE = 'Delete '
const DELETE_2 = 'Delete'

/**
 * Delete with a guard: lists what still points at the entry and what it served in the last
 * seven days, then removes it alone (when nothing points at it) or with its dependents.
 */
export function DeleteGuard(props: {
  doc: Doc
  table: string
  id: string
  index: number
  addresses: string[]
}) {
  const [deps, setDeps] = useState<string[] | undefined>()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (deps !== undefined) {
      dialog.current?.showModal()
    }
  }, [deps])
  const calls = props.addresses.reduce((sum, a) => sum + callsFor(a), 0)
  const start = async () => {
    const found = await call<{ dependents: string[] }>('/api/dependents', {
      text: draft.value,
      table: props.table,
      id: props.id,
    }).catch(() => ({ dependents: [] as string[] }))
    setDeps(found.dependents)
  }
  const remove = async () => {
    const ops = [
      ...removalOps(props.doc, deps ?? []),
      { op: 'removeEntry' as const, table: props.table, index: props.index },
    ]
    if (await editDraft(ops)) {
      dialog.current?.close()
    }
  }
  return (
    <>
      <button type="button" className="small danger" onClick={start}>
        {DELETE_2}
      </button>
      {deps === undefined ? null : (
        // Esc and Cancel both close the dialog; its close event is the one place the guard resets.
        <dialog ref={dialog} className="guard panel" onClose={() => setDeps(undefined)}>
          <strong>
            {DELETE}
            {props.table}
            {SEPARATOR_3}
            {props.id}
            {SEPARATOR_2}
          </strong>
          <p className="muted">
            {plural(calls, 'call')}
            {IN_THE_LAST_7} {plural(props.addresses.length, 'address', 'addresses')}
            {SEPARATOR}
          </p>
          {deps.length === 0 ? (
            <p className="ok">{NOTHING_ELSE_POINTS_AT}</p>
          ) : (
            <>
              <p>{STILL_REFERENCED_BY}</p>
              <ul>
                {deps.map((d) => (
                  <li key={d}>
                    <code>{d}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" className="danger" onClick={remove}>
            {deps.length === 0 ? 'Delete' : 'Remove it and its dependents'}
          </button>{' '}
          <button type="button" onClick={() => dialog.current?.close()}>
            {CANCEL}
          </button>
        </dialog>
      )}
    </>
  )
}
