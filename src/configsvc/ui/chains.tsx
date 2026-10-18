import { computed } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { qualifiedSegments } from '../../routeAddress.ts'
import { editDraft } from './actions.ts'
import {
  type ChainPreview,
  chainExpansion,
  type HopState,
  hopChoices,
  hopState,
} from './addresses.ts'
import { discovery, ensureSpec, loadDiscovery, upstreamResolver } from './data.ts'
import { DeleteGuard } from './guardPanel.tsx'
import { HopPicker } from './hopPicker.tsx'
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

function expansionText(preview: ChainPreview): string {
  if (preview.kind === 'cycle') {
    return preview.text
  }
  return preview.addresses.length === 0
    ? 'inserts nothing'
    : `inserts ${preview.addresses.join(', ')}`
}

function hopNote(d: Doc, hop: string, state: HopState): string {
  const chain = qualifiedSegments(hop)?.length === 1
  if (state === 'dropped' && chain && d.chain.some((c) => `@/${String(c.id)}` === hop)) {
    return 'dropped: the chain is disabled'
  }
  if (state === 'unresolved' && chain) {
    return 'is not a chain'
  }
  return NOTE[state]
}

function Chain({ d, chain, index }: { d: Doc; chain: Table; index: number }) {
  const id = String(chain.id)
  const upstreamOf = upstreamResolver(d)
  const hops = Array.isArray(chain.hops) ? (chain.hops as string[]) : []
  const [dragFrom, setDragFrom] = useState<number | undefined>()
  const [dropAt, setDropAt] = useState<number | undefined>()
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
        <span class="group">
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
        </span>
      </div>
      {/* A chain may name the same hop twice, so keys come from position among equal hops. */}
      <ol class="hops">
        {hops.map((hop, i) => {
          const key = lineKeys(hops)[i]
          const state = hopState(d, hop, upstreamOf)
          const expansion = chainExpansion(d, hop, upstreamOf)
          return (
            <li
              class={`hop${
                dropAt !== i || dragFrom === undefined || dragFrom === i
                  ? ''
                  : dragFrom < i
                    ? ' drop-after'
                    : ' drop-before'
              }`}
              key={key}
              draggable
              onDragStart={(e) => {
                setDragFrom(i)
                // Firefox starts a drag only when the transfer carries data.
                e.dataTransfer?.setData('text/plain', hop)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDropAt(i)
              }}
              onDragEnd={() => {
                setDragFrom(undefined)
                setDropAt(undefined)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragFrom !== undefined && dragFrom !== i) {
                  move(dragFrom, i)
                }
              }}
            >
              <span class="muted">{i + 1}.</span>
              <span class="hopaddr">
                <code>{hop}</code>
                {expansion === undefined ? null : (
                  <span class={expansion.kind === 'cycle' ? 'bad small-text' : 'muted small-text'}>
                    {expansionText(expansion)}
                  </span>
                )}
                {state === 'ok' ? null : (
                  <span class="bad small-text">{hopNote(d, hop, state)}</span>
                )}
              </span>
              <span class="group">
                <button
                  type="button"
                  class="icon"
                  title="Move up"
                  aria-label={`Move ${hop} up`}
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="icon"
                  title="Move down"
                  aria-label={`Move ${hop} down`}
                  disabled={i === hops.length - 1}
                  onClick={() => move(i, i + 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  class="icon"
                  title="Remove"
                  aria-label={`Remove ${hop}`}
                  onClick={() => set(hops.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </span>
            </li>
          )
        })}
      </ol>
      <div class="addrow">
        <HopPicker
          choices={hopChoices(d, upstreamOf, discovery.value.inventories, id)}
          taken={hops}
          onAdd={(added) => set([...hops, ...added])}
        />
      </div>
    </section>
  )
}

export function ChainsView() {
  const [id, setId] = useState('')
  useEffect(() => {
    void loadDiscovery()
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
        <button
          type="button"
          onClick={() => {
            location.hash = 'add/chain'
          }}
        >
          Use the Add wizard
        </button>
      </div>
      <SnippetBox table="chain" />
    </section>
  )
}
