import { useState } from 'preact/hooks'
import type { EditOp } from '../../editOps.ts'
import { setDraft } from './actions.ts'
import { call } from './api.ts'
import { snippetEntries } from './snippet.ts'
import { draft, type Problem, problems } from './store.ts'

/** Paste `[[table]]` TOML to add its entries; the merged text is validated first and refused if it introduces a fault. */
export function SnippetBox(props: { table: string }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const merge = async () => {
    const read = snippetEntries(text, props.table)
    if ('error' in read) {
      setError(read.error)
      return
    }
    try {
      const ops: EditOp[] = read.entries.map((entry) => ({
        op: 'addEntry',
        table: props.table,
        entry,
      }))
      const edited = await call<{ text: string }>('/api/edit', { text: draft.value, ops })
      const checked = await call<{ errors: Problem[] }>('/api/validate', { text: edited.text })
      const known = new Set(problems.value.map((p) => p.message))
      const fresh = checked.errors.find((p) => !known.has(p.message))
      if (fresh !== undefined) {
        setError(fresh.message)
        return
      }
      setDraft(edited.text)
      setText('')
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <details class="panel">
      <summary>Paste a [[{props.table}]] snippet</summary>
      <textarea
        rows={6}
        class="snippet"
        value={text}
        placeholder={`[[${props.table}]]\nid = "..."`}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div class="rowhead">
        <button type="button" disabled={text.trim() === ''} onClick={merge}>
          Validate and add
        </button>
        {error === undefined ? null : <span class="bad small-text">{error}</span>}
      </div>
    </details>
  )
}
