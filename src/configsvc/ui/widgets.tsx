import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import type { TomlPath } from '../../editOps.ts'
import { editDraft } from './actions.ts'
import { propOf } from './schema.ts'

/** Copies text and says so for a moment; the clipboard needs a secure context, which loopback is. */
export function CopyButton(props: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text)
      setDone(true)
      setTimeout(() => setDone(false), 1200)
    } catch {
      setDone(false)
    }
  }
  return (
    <button type="button" class="small" onClick={copy}>
      {done ? 'Copied' : (props.label ?? 'Copy')}
    </button>
  )
}

export function Labeled(props: {
  label: string
  help?: string
  warn?: string
  children: ComponentChildren
}) {
  return (
    <div class="field" title={props.help}>
      <span class="fieldname">{props.label}</span>
      {props.children}
      {props.warn === undefined ? null : <span class="bad small-text">{props.warn}</span>}
      {props.help === undefined ? null : <span class="muted small-text">{props.help}</span>}
    </div>
  )
}

const asText = (v: unknown): string =>
  Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v)

function fromText(raw: string, type: string | undefined, array: boolean): unknown {
  const t = raw.trim()
  if (t === '') {
    return undefined
  }
  if (array) {
    return t
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== '')
  }
  if (type === 'integer' || type === 'number') {
    const n = Number(t)
    return Number.isFinite(n) ? n : t
  }
  return raw
}

/** One key of a table as a form control, typed from config.schema.json; a blank input removes the key. */
export function Prop(props: {
  table: string
  name: string
  value: unknown
  path: TomlPath
  /** Suggestions for a text field. */
  options?: readonly string[]
  /** Why the field is read-only, shown instead of an editable control. */
  locked?: string
  warn?: string
  label?: string
}) {
  const prop = propOf(props.table, props.name)
  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type
  const commit = (value: unknown) => void editDraft([{ op: 'setKey', path: props.path, value }])
  const listId =
    props.options === undefined
      ? undefined
      : `opts-${props.table}-${props.name}-${props.path.join('-')}`
  let control: ComponentChildren
  if (props.locked !== undefined) {
    control = <input value={asText(props.value)} disabled={true} />
  } else if (type === 'boolean') {
    const current = props.value === undefined ? '' : String(props.value)
    control = (
      <select
        value={current}
        onChange={(e) =>
          commit(e.currentTarget.value === '' ? undefined : e.currentTarget.value === 'true')
        }
      >
        <option value="">(unset)</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  } else if (prop.enum === undefined) {
    control = (
      <>
        <input
          list={listId}
          type="text"
          inputMode={type === 'integer' || type === 'number' ? 'decimal' : undefined}
          value={asText(props.value)}
          onChange={(e) => commit(fromText(e.currentTarget.value, type, type === 'array'))}
        />
        {listId === undefined ? null : (
          <datalist id={listId}>
            {props.options?.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        )}
      </>
    )
  } else {
    control = (
      <select
        value={asText(props.value)}
        onChange={(e) => commit(e.currentTarget.value === '' ? undefined : e.currentTarget.value)}
      >
        <option value="">(unset)</option>
        {prop.enum.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    )
  }
  return (
    <Labeled
      label={props.label ?? props.name}
      help={props.locked ?? prop.description}
      warn={props.warn}
    >
      {control}
    </Labeled>
  )
}
