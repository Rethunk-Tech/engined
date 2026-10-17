import { computed } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { editDraft } from './actions.ts'
import { type HopState, hopChoices, hopState } from './addresses.ts'
import { ensureSpec, upstreamResolver } from './data.ts'
import { DeleteGuard } from './guardPanel.tsx'
import { type Doc, parseDoc, type Table } from './model.ts'
import { entryToToml } from './snippet.ts'
import { SnippetBox } from './snippets.tsx'
import { draft } from './store.ts'
import { CopyButton, lineKeys } from './widgets.tsx'

const doc = computed(() => parseDoc(draft.value))

const NOTE: Record<HopState, string> = {
  ok: '',
  dropped: 'dropped: its routes are disabled',
  unresolved: 'matches no route',
}

function Chain({ d, chain, index }: { d: Doc; chain: Table; index: number }) {
  const id = String(chain.id)
  const upstreamOf = upstreamResolver(d)
  const hops = Array.isArray(chain.hops) ? (chain.hops as string[]) : []
  const [pick, setPick] = useState('')
  const set = (next: string[]) =>
    void editDraft([{ op: 'setKey', path: ['chain', index, 'hops'], value: next }])
  const move = (from: number, to: number) => {
    const next = [...hops]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item as string)
    set(next)
  }
  return (
    <section class={`panel${chain.disable === true ? ' off' : ''}`}>
      <div class="rowhead">
        <h3>{id}</h3>
        <code>@/{id}</code>
        <span class="grow" />
        <button
          type="button"
          class="small"
          onClick={() =>
            void editDraft([
              {
                op: 'setKey',
                path: ['chain', index, 'disable'],
                value: chain.disable === true ? undefined : true,
              },
            ])
          }
        >
          {chain.disable === true ? 'Enable' : 'Disable'}
        </button>
        <CopyButton text={entryToToml('chain', chain)} label="Copy TOML" />
        <DeleteGuard doc={d} table="chain" id={id} index={index} addresses={[`@/${id}`]} />
      </div>
      {/* A chain may name the same hop twice, so keys come from position among equal hops. */}
      <div class="hops" style={`--addr-w: ${Math.max(0, ...hops.map((h) => h.length))}ch`}>
        {hops.map((hop, i) => {
          const key = lineKeys(hops)[i]
          const state = hopState(d, hop, upstreamOf)
          return (
            <div class="hop" key={key}>
              <span class="muted">{i + 1}.</span>
              <code class="addr">{hop}</code>
              <span class="bad small-text">{NOTE[state]}</span>
              <span class="group">
                <button
                  type="button"
                  class="small"
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                >
                  Up
                </button>
                <button
                  type="button"
                  class="small"
                  disabled={i === hops.length - 1}
                  onClick={() => move(i, i + 1)}
                >
                  Down
                </button>
                <button
                  type="button"
                  class="small"
                  onClick={() => set(hops.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </span>
            </div>
          )
        })}
      </div>
      <div class="addrow">
        <select value={pick} onChange={(e) => setPick(e.currentTarget.value)}>
          <option value="">add a hop…</option>
          {hopChoices(d, upstreamOf).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button
          type="button"
          class="small"
          disabled={pick === ''}
          onClick={() => {
            set([...hops, pick])
            setPick('')
          }}
        >
          Add hop
        </button>
      </div>
    </section>
  )
}

export function ChainsView() {
  const [id, setId] = useState('')
  useEffect(() => {
    for (const e of doc.value?.engine ?? []) {
      void ensureSpec(String(e.id))
    }
  }, [])
  const parsed = doc.value
  if (parsed === undefined) {
    return <p class="bad">The pending text is not valid TOML; fix it on the Raw TOML view first.</p>
  }
  return (
    <section>
      <p class="muted">A chain tries its hops in order and moves to the next when one fails.</p>
      <div class="chain-grid">
        {parsed.chain.map((c, i) => (
          <Chain key={String(c.id)} d={parsed} chain={c} index={i} />
        ))}
      </div>
      <div class="panel rowhead">
        <input
          placeholder="new chain id"
          value={id}
          onInput={(e) => setId(e.currentTarget.value)}
        />
        <button
          type="button"
          disabled={id === ''}
          onClick={async () => {
            if (await editDraft([{ op: 'addEntry', table: 'chain', entry: { id, hops: [] } }])) {
              setId('')
            }
          }}
        >
          Add chain
        </button>
      </div>
      <SnippetBox table="chain" />
    </section>
  )
}
