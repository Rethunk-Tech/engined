import { computed } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { fork } from './api.ts'
import { DeleteGuard } from './guardPanel.tsx'
import { type Doc, parseDoc, routeAddress, type Table } from './model.ts'
import { loadSchema } from './schema.ts'
import { entryToToml } from './snippet.ts'
import { SnippetBox } from './snippets.tsx'
import { draft } from './store.ts'
import { AddEntryRow, CopyButton, InvalidToml, Prop } from './widgets.tsx'

const CAPABILITY_ROWS_A_ROUTE =
  "Capability rows a route can inherit by naming the model; a route's own fields win."
const INHERITED_BY = 'Inherited by '

const doc = computed(() => parseDoc(draft.value))

function ModelCard({ d, model, index }: { d: Doc; model: Table; index: number }) {
  const id = String(model.id)
  const inheriting = d.route.filter((r) => r.model === id)
  const addresses = inheriting.flatMap((r) => routeAddress(d, r) ?? [])
  return (
    <section className="panel">
      <div className="rowhead">
        <h3>{id}</h3>
        <span className="grow" />
        <CopyButton text={entryToToml('model', model)} label="Copy TOML" />
        <DeleteGuard doc={d} table="model" id={id} index={index} addresses={addresses} />
      </div>
      <div className="form">
        {(['input', 'output', 'context_in', 'context_out', 'reasoning'] as const).map((k) => (
          <Prop key={k} table="model" name={k} value={model[k]} path={['model', index, k]} />
        ))}
      </div>
      <p className="muted small-text">
        {INHERITED_BY}
        {addresses.length === 0 ? 'no routes' : addresses.join(', ')}
      </p>
    </section>
  )
}

export function ModelsView() {
  useEffect(() => {
    fork(loadSchema())
  }, [])
  const parsed = doc.value
  if (parsed === undefined) {
    return <InvalidToml />
  }
  return (
    <section>
      <p className="muted">{CAPABILITY_ROWS_A_ROUTE}</p>
      {parsed.model.map((m, i) => (
        <ModelCard key={String(m.id)} d={parsed} model={m} index={i} />
      ))}
      <AddEntryRow
        table="model"
        label="Add model"
        placeholder="new model id"
        entry={(id) => ({ id })}
      />
      <SnippetBox table="model" />
    </section>
  )
}
