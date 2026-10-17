import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import type { TomlPath } from '../../editOps.ts'
import { type EngineKind, KIND_LABELS } from '../../types.ts'
import { editDraft } from './actions.ts'
import { propOf } from './schema.ts'

/** Copies text and says so for a moment; the clipboard needs a secure context, which loopback is. */
export function CopyButton(props: { text: string; label?: string; title?: string }) {
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
    <button type="button" class="small" title={props.title} onClick={copy}>
      {done ? 'Copied' : (props.label ?? 'Copy')}
    </button>
  )
}

export function Labeled(props: {
  label: string
  help?: string
  warn?: string
  /** A fact about the current value, such as the size of the file it names. */
  note?: string
  children: ComponentChildren
}) {
  return (
    <div class="field" title={props.help}>
      <span class="fieldname">{props.label}</span>
      {props.children}
      {props.warn === undefined ? null : <span class="bad small-text">{props.warn}</span>}
      {props.note === undefined ? null : <span class="small-text">{props.note}</span>}
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
  note?: string
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
    // Three states, not a checkbox: an absent key takes the default, which is not the same as false.
    control = (
      <fieldset class="seg">
        {(['', 'true', 'false'] as const).map((v) => (
          <button
            key={v}
            type="button"
            class={current === v ? 'on' : ''}
            aria-pressed={current === v}
            onClick={() => commit(v === '' ? undefined : v === 'true')}
          >
            {v === '' ? 'default' : v}
          </button>
        ))}
      </fieldset>
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
        <option value="">(default)</option>
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
      note={props.note}
    >
      {control}
    </Labeled>
  )
}

/** Keys for lines of text, which may repeat: the line plus how many equal ones came before it. */
export function lineKeys(lines: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return lines.map((line) => {
    const n = seen.get(line) ?? 0
    seen.set(line, n + 1)
    return `${line}#${n}`
  })
}

/** A unified diff with added and removed lines tinted. */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  const keys = lineKeys(lines)
  return (
    <pre class="diff">
      {lines.map((line, i) => (
        <div key={keys[i]} class={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''}>
          {line}
        </div>
      ))}
    </pre>
  )
}

/** What a shipped engine is, from its spec's `description` and `homepage`. */
export function About({ info }: { info: { description?: string; homepage?: string } | undefined }) {
  if (info?.description === undefined && info?.homepage === undefined) {
    return null
  }
  return (
    <p class="small-text">
      {info.description}
      {info.homepage === undefined ? null : (
        <>
          {' '}
          <a href={info.homepage} target="_blank" rel="noreferrer">
            {info.homepage.replace(/^https:\/\//, '')}
          </a>
        </>
      )}
    </p>
  )
}

/** An engine's kind in plain words; the raw kind is the tooltip. */
export function KindPill({ kind }: { kind: string | undefined }) {
  const label =
    kind !== undefined && Object.hasOwn(KIND_LABELS, kind)
      ? KIND_LABELS[kind as EngineKind]
      : (kind ?? 'unknown kind')
  return (
    <span class="pill" title={kind}>
      {label}
    </span>
  )
}

const ICONS = {
  running: (
    <>
      <circle class="pulse" cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="3.5" fill="currentColor" stroke="none" />
    </>
  ),
  installed: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.3 8.2 7.2 10l3.5-3.8" />
    </>
  ),
  warming: (
    <>
      <circle cx="8" cy="8" r="6" opacity="0.3" />
      <path d="M8 2a6 6 0 0 1 6 6" />
    </>
  ),
  unavailable: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.8v3.6M8 11v.01" />
    </>
  ),
  disabled: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M3.6 3.6l8.8 8.8" />
    </>
  ),
  home: <path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5" />,
  lan: (
    <>
      <rect x="6" y="2" width="4" height="3" />
      <rect x="2" y="11" width="4" height="3" />
      <rect x="10" y="11" width="4" height="3" />
      <path d="M8 5v3M4 11V8h8v3" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12" />
    </>
  ),
}

export type IconName = keyof typeof ICONS

/** A line icon drawn on a 16-unit grid; `label` is its accessible name and tooltip. */
export function Icon(props: { name: IconName; label: string; tone?: string; size?: number }) {
  const { name, label, tone, size = 16 } = props
  return (
    <svg
      class={`icon icon-${name}${tone === undefined ? '' : ` ${tone}`}`}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {ICONS[name]}
    </svg>
  )
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`
}
