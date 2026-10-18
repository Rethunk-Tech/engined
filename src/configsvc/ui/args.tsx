import { useState } from 'preact/hooks'
import type { TomlPath } from '../../editOps.ts'
import type { EngineKind } from '../../types.ts'
import { editDraft } from './actions.ts'
import { fork } from './api.ts'
import { argIssue, argValueFromText } from './argsRules.ts'
import type { Table } from './model.ts'

interface Scope {
  site: 'route' | 'engine'
  kind: EngineKind | undefined
}

function ArgRow(props: {
  name: string
  value: unknown
  path: TomlPath
  scope: Scope
  options: string[]
}) {
  const [text, setText] = useState(String(props.value))
  const issue = argIssue(props.name, argValueFromText(text), props.scope)
  const listId = `arg-${props.path.join('-')}-${props.name}`
  return (
    <div className="kvrow">
      <code>{props.name}</code>
      <input
        list={props.options.length > 0 ? listId : undefined}
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        onChange={() => {
          if (issue === undefined) {
            fork(
              editDraft([
                { op: 'setKey', path: [...props.path, props.name], value: argValueFromText(text) },
              ]),
            )
          }
        }}
      />
      {props.options.length > 0 ? (
        <datalist id={listId}>
          {props.options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      ) : null}
      <button
        type="button"
        className="small"
        onClick={() =>
          fork(editDraft([{ op: 'setKey', path: [...props.path, props.name], value: undefined }]))
        }
      >
        Remove
      </button>
      {issue === undefined ? null : <span className="bad small-text">{issue}</span>}
    </div>
  )
}

/** The `args` table of a route or an engine: each entry checked with the parser's own rules as it is typed. */
export function ArgsEditor(props: {
  args: unknown
  path: TomlPath
  scope: Scope
  suggestions: string[]
  valueOptions?: (key: string) => string[]
}) {
  const keysId = `arg-keys-${props.path.join('-')}`
  const valuesId = `arg-values-${props.path.join('-')}`
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const entries =
    typeof props.args === 'object' && props.args !== null ? Object.entries(props.args as Table) : []
  const issue = key === '' ? undefined : argIssue(key, argValueFromText(value), props.scope)
  const add = async () => {
    if (
      key !== '' &&
      issue === undefined &&
      (await editDraft([
        { op: 'setKey', path: [...props.path, key], value: argValueFromText(value) },
      ]))
    ) {
      setKey('')
      setValue('')
    }
  }
  return (
    <div className="args">
      {entries.map(([name, v]) => (
        <ArgRow
          key={name}
          name={name}
          value={v}
          path={props.path}
          scope={props.scope}
          options={props.valueOptions?.(name) ?? []}
        />
      ))}
      <div className="kvrow">
        <input
          list={keysId}
          placeholder="key"
          value={key}
          onInput={(e) => setKey(e.currentTarget.value)}
        />
        <datalist id={keysId}>
          {props.suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <input
          list={props.valueOptions !== undefined && key !== '' ? valuesId : undefined}
          placeholder="value"
          value={value}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
        <datalist id={valuesId}>
          {(props.valueOptions?.(key) ?? []).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <button
          type="button"
          className="small"
          disabled={key === '' || issue !== undefined}
          onClick={add}
        >
          Add
        </button>
        {issue === undefined ? null : <span className="bad small-text">{issue}</span>}
      </div>
    </div>
  )
}
