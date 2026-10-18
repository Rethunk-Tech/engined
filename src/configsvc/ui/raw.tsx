import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { effect } from '@preact/signals'
import { basicSetup } from 'codemirror'
import { useEffect, useRef } from 'preact/hooks'
import { setDraft } from './actions.ts'
import { locate } from './locate.ts'
import { draft, problems, snapshot } from './store.ts'

const highlight = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--ok)' },
  { tag: [tags.number, tags.bool, tags.atom], color: 'var(--warn)' },
  { tag: [tags.propertyName, tags.keyword], color: 'var(--accent)' },
  { tag: tags.heading, color: 'var(--accent)', fontWeight: '600' },
])

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--panel)', color: 'var(--text)', height: '60vh' },
  '.cm-scroller': { fontFamily: 'ui-monospace, monospace', fontSize: '12.5px' },
  '.cm-gutters': { backgroundColor: 'var(--panel-2)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--panel-2)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
})

/** Problems in `config.toml` itself; one in a `config.d` fragment has no place in this text. */
function ownProblems() {
  const own = snapshot.value?.path
  return problems.value.filter((p) => p.file === undefined || p.file === own)
}

function diagnostics(view: EditorView): Diagnostic[] {
  const text = view.state.doc.toString()
  return ownProblems().map((p) => {
    const span = locate(text, p)
    return {
      from: span.from,
      to: Math.max(span.to, span.from),
      severity: 'error',
      message: p.message,
    }
  })
}

let editor: EditorView | undefined

function jumpTo(index: number): void {
  const problem = ownProblems()[index]
  if (editor === undefined || problem === undefined) {
    return
  }
  const span = locate(editor.state.doc.toString(), problem)
  editor.dispatch({ selection: { anchor: span.from }, scrollIntoView: true })
  editor.focus()
}

export function RawView() {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (host.current === null) {
      return
    }
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: draft.value,
        extensions: [
          basicSetup,
          StreamLanguage.define(toml),
          syntaxHighlighting(highlight),
          theme,
          lintGutter(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              setDraft(update.state.doc.toString())
            }
          }),
        ],
      }),
    })
    editor = view
    // A form edit changes the draft under the editor; a new validate result redraws the markers.
    const follow = effect(() => {
      const text = draft.value
      if (view.state.doc.toString() !== text) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      }
    })
    // Problems arrive from the server after a debounce, so they are pushed into the editor when
    // they change rather than pulled by a linter that runs before they exist.
    const relint = effect(() => {
      if (problems.value) {
        view.dispatch(setDiagnostics(view.state, diagnostics(view)))
      }
    })
    return () => {
      follow()
      relint()
      view.destroy()
      editor = undefined
    }
  }, [])

  const shown = problems.value
  const own = ownProblems()
  const saved = snapshot.value
  return (
    <section>
      <div ref={host} className="editor" />
      {shown.length === 0 ? (
        <p className="ok">The pending text loads cleanly.</p>
      ) : (
        <ul className="errors">
          {shown.map((p) => {
            const at = own.indexOf(p)
            return (
              <li key={`${p.file}:${p.line}:${p.message}`}>
                <button type="button" className="link" disabled={at < 0} onClick={() => jumpTo(at)}>
                  {p.file === undefined ? 'config' : (p.file.split('/').pop() ?? p.file)}
                  {p.line === undefined
                    ? ''
                    : `:${p.line}${p.column === undefined ? '' : `:${p.column}`}`}
                </button>{' '}
                {p.message}
              </li>
            )
          })}
        </ul>
      )}
      {saved?.fragments.map((f) => (
        <details key={f.file} className="panel">
          <summary>
            {f.file} <span className="muted">(read-only; edit it on disk)</span>
          </summary>
          <pre>{f.text}</pre>
        </details>
      ))}
    </section>
  )
}
