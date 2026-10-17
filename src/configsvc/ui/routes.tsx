import { signal } from '@preact/signals'
import { useState } from 'preact/hooks'
import example from '../../../config.example.toml'
import type { EngineKind, UpstreamTrait } from '../../types.ts'
import { editDraft } from './actions.ts'
import { call } from './api.ts'
import { ArgsEditor } from './args.tsx'
import { suggestArgKeys } from './argsRules.ts'
import { callsFor, discovery, modelFiles, type SpecEntry } from './data.ts'
import { type Doc, type IndexedRoute, routeAddress, type Table, upstreamChoices } from './model.ts'
import { resolveRoute } from './resolved.ts'
import { ctxSizeOf, ctxWarning, keepResidentHolder, routePlan } from './routeRules.ts'
import { comfyChoices, formatBytes, modelSuggestions, trainedContext } from './suggest.ts'
import { CopyButton, Labeled, Prop } from './widgets.tsx'

export interface EngineCtx {
  doc: Doc
  engine: Table
  kind: EngineKind | undefined
  trait: UpstreamTrait | undefined
  spec: SpecEntry | null | undefined
}

interface TestResult {
  status: number
  ms: number
  error?: string
}

const tests = signal<Record<string, TestResult | 'running'>>({})

async function testRoute(address: string): Promise<void> {
  tests.value = { ...tests.value, [address]: 'running' }
  try {
    const got = await call<TestResult>('/api/test-route', { address })
    tests.value = { ...tests.value, [address]: got }
  } catch (err) {
    tests.value = { ...tests.value, [address]: { status: 0, ms: 0, error: String(err) } }
  }
}

function TestBadge({ address }: { address: string }) {
  const result = tests.value[address]
  if (result === undefined) {
    return null
  }
  if (result === 'running') {
    return <span class="muted">testing…</span>
  }
  const ok = result.status >= 200 && result.status < 300
  return (
    <span class={ok ? 'ok' : 'bad'} title={result.error}>
      {result.status === 0 ? 'unreachable' : result.status} · {result.ms} ms {result.error ?? ''}
    </span>
  )
}

function UpstreamSelect(props: {
  ctx: EngineCtx
  route: Table
  path: (string | number)[]
  fallback: string
}) {
  const choices = upstreamChoices(
    props.ctx.trait,
    props.ctx.spec?.info.agent,
    props.ctx.doc.upstream,
  )
  const current = typeof props.route.upstream === 'string' ? props.route.upstream : ''
  const known = current === '' || choices.includes(current)
  return (
    <Labeled
      label="upstream"
      help="Which upstream serves this route. Blank takes the engine's default."
      warn={known ? undefined : `"${current}" is not an upstream this engine can use`}
    >
      <select
        value={current}
        onChange={(e) =>
          void editDraft([
            {
              op: 'setKey',
              path: props.path,
              value: e.currentTarget.value === '' ? undefined : e.currentTarget.value,
            },
          ])
        }
      >
        <option value="">(default: {props.fallback})</option>
        {known ? null : <option value={current}>{current}</option>}
        {choices.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </Labeled>
  )
}

function Resolved(props: { ctx: EngineCtx; route: Table }) {
  const done = resolveRoute(props.ctx.doc, props.route, props.ctx.engine, props.ctx.spec?.info)
  return (
    <details class="resolved">
      <summary>Resolved route</summary>
      <p>
        upstream <code>{done.upstream.value ?? 'ambient'}</code>{' '}
        <span class="muted">({done.upstream.note})</span>
      </p>
      <p>
        capabilities <code>{JSON.stringify(done.capabilities)}</code>
      </p>
      <table class="grid">
        <tbody>
          {done.floor.length === 0 ? null : (
            <tr>
              <td class="muted">floor</td>
              <td colSpan={2}>
                <code>{done.floor.join(' ')}</code>{' '}
                <span class="muted">(engined's own; a config cannot change it)</span>
              </td>
            </tr>
          )}
          {done.args.map((row) => (
            <tr key={row.key}>
              <td>
                <code>{row.key}</code>
              </td>
              <td>
                <code>{String(row.value)}</code>
              </td>
              <td class="muted">
                {row.source}
                {row.overrides === undefined ? '' : ` (over ${String(row.overrides)})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

type Plan = ReturnType<typeof routePlan>

function RouteFlags(props: { ctx: EngineCtx; entry: IndexedRoute; plan: Plan }) {
  const { ctx, entry, plan } = props
  const route = entry.route
  const base = ['route', entry.index]
  const shown = (field: keyof Plan) => plan[field].disposition !== 'forbidden'
  const holder = keepResidentHolder(ctx.doc.route, route)
  return (
    <>
      {shown('translate') ? (
        <Prop
          table="route"
          name="translate"
          value={route.translate}
          path={[...base, 'translate']}
        />
      ) : null}
      {shown('fim') ? (
        <Prop table="route" name="fim" value={route.fim} path={[...base, 'fim']} />
      ) : null}
      {shown('keep_resident') || holder !== undefined ? (
        <Prop
          table="route"
          name="keep_resident"
          value={route.keep_resident}
          path={[...base, 'keep_resident']}
          locked={
            holder === undefined || route.keep_resident === true
              ? undefined
              : `another ${String(route.role)} route on this engine already keeps ${routeAddress(ctx.doc, holder) ?? 'a model'} resident; one per role`
          }
        />
      ) : null}
      <Prop table="route" name="streaming" value={route.streaming} path={[...base, 'streaming']} />
      {route.model === '*' ? null : (
        <Prop
          table="route"
          name="slot_long_threshold"
          value={route.slot_long_threshold}
          path={[...base, 'slot_long_threshold']}
        />
      )}
      {(['input', 'output', 'context_in', 'context_out', 'reasoning'] as const).map((key) => (
        <Prop key={key} table="route" name={key} value={route[key]} path={[...base, key]} />
      ))}
    </>
  )
}

function RouteArgs(props: { ctx: EngineCtx; entry: IndexedRoute; plan: Plan }) {
  const { ctx, entry, plan } = props
  const route = entry.route
  const base = ['route', entry.index]
  const files = modelFiles.value.find((f) => f.engine === ctx.engine.id)?.files ?? []
  return (
    <>
      {plan.args.disposition === 'forbidden' ? null : (
        <div class="argsbox">
          <strong>args</strong>
          <ArgsEditor
            args={route.args}
            path={[...base, 'args']}
            scope={{ site: 'route', kind: ctx.kind }}
            suggestions={suggestArgKeys(
              ctx.spec?.info.args === undefined ? undefined : { args: ctx.spec.info.args },
              example as Table,
              Object.keys((route.args as Table | undefined) ?? {}),
            )}
            valueOptions={ctx.kind === 'comfy' ? (key) => comfyChoices(files, key) : undefined}
          />
        </div>
      )}
    </>
  )
}

function RouteForm(props: { ctx: EngineCtx; entry: IndexedRoute }) {
  const { ctx, entry } = props
  const { doc, engine } = ctx
  const route = entry.route
  const base = ['route', entry.index]
  const done = resolveRoute(doc, route, engine, ctx.spec?.info)
  const plan = routePlan({ kind: ctx.kind, engine, route, upstream: done.upstream.value })
  const files = modelFiles.value.find((f) => f.engine === engine.id)?.files ?? []
  const upstreamId =
    typeof route.upstream === 'string' ? route.upstream : (done.upstream.value ?? undefined)
  const visionRoutes = doc.route
    .filter((r) => r.role === 'vision' && r.disable !== true)
    .flatMap((r) => routeAddress(doc, r) ?? [])
  const shown = (field: keyof typeof plan) => plan[field].disposition !== 'forbidden'
  const file = files.find(
    (f) => f.path === route.filename || f.path.endsWith(`/${String(route.filename)}`),
  )
  return (
    <div class="form">
      <Prop
        table="route"
        name="model"
        value={route.model}
        path={[...base, 'model']}
        options={modelSuggestions(doc, String(engine.id), upstreamId, discovery.value)}
      />
      <UpstreamSelect
        ctx={ctx}
        route={route}
        path={[...base, 'upstream']}
        fallback={done.upstream.note}
      />
      {route.model === '*' ? null : (
        <Prop
          table="route"
          name="wire_model"
          value={route.wire_model}
          path={[...base, 'wire_model']}
        />
      )}
      <Prop
        table="route"
        name="display_name"
        value={route.display_name}
        path={[...base, 'display_name']}
      />
      {shown('filename') ? (
        <Prop
          table="route"
          name="filename"
          value={route.filename}
          path={[...base, 'filename']}
          options={files.map((f) => f.path)}
        />
      ) : null}
      {file === undefined ? null : (
        <p class="muted small-text">
          {formatBytes(file.bytes)}
          {file.gguf === undefined
            ? ''
            : ` · ${file.gguf.architecture ?? '?'} · ${file.gguf.quantization ?? '?'} · trained context ${file.gguf.context_length ?? '?'}`}
        </p>
      )}
      {shown('role') ? (
        <Prop table="route" name="role" value={route.role} path={[...base, 'role']} />
      ) : null}
      {shown('vision') ? (
        <Prop table="route" name="vision" value={route.vision} path={[...base, 'vision']} />
      ) : null}
      {shown('vision_bridge') ? (
        <Prop
          table="route"
          name="vision_bridge"
          value={route.vision_bridge}
          path={[...base, 'vision_bridge']}
          options={visionRoutes}
        />
      ) : null}
      <RouteFlags ctx={ctx} entry={entry} plan={plan} />
      <RouteArgs ctx={ctx} entry={entry} plan={plan} />
      <Resolved ctx={ctx} route={route} />
    </div>
  )
}

export function RouteCard(props: { ctx: EngineCtx; entry: IndexedRoute }) {
  const { ctx, entry } = props
  const { doc, engine } = ctx
  const route = entry.route
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const base = ['route', entry.index]
  const address = routeAddress(doc, route)
  const files = modelFiles.value.find((f) => f.engine === engine.id)?.files ?? []
  const warn = ctxWarning(
    ctxSizeOf(route, engine),
    trainedContext(files, route.filename as string | undefined),
  )
  const chains = doc.chain.filter(
    (c) => Array.isArray(c.hops) && address !== undefined && c.hops.includes(address),
  )
  return (
    <div class={`route panel${route.disable === true ? ' off' : ''}`}>
      <div class="rowhead">
        <code>{address ?? '(incomplete)'}</code>
        {address === undefined ? null : <CopyButton text={address} />}
        <span class="muted">{callsFor(address)} call(s) / 7 d</span>
        <span class="grow" />
        {address === undefined ? null : (
          <>
            <TestBadge address={address} />
            <button type="button" class="small" onClick={() => void testRoute(address)}>
              Test
            </button>
          </>
        )}
        <button
          type="button"
          class="small"
          onClick={() =>
            void editDraft([
              {
                op: 'setKey',
                path: [...base, 'disable'],
                value: route.disable === true ? undefined : true,
              },
            ])
          }
        >
          {route.disable === true ? 'Enable' : 'Disable'}
        </button>
        <button type="button" class="small" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Edit'}
        </button>
        {confirm ? (
          <>
            <button
              type="button"
              class="small danger"
              onClick={() =>
                void editDraft([{ op: 'removeEntry', table: 'route', index: entry.index }])
              }
            >
              Confirm delete
            </button>
            <button type="button" class="small" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" class="small danger" onClick={() => setConfirm(true)}>
            Delete
          </button>
        )}
      </div>
      {confirm && chains.length > 0 ? (
        <p class="bad small-text">
          Chain(s) {chains.map((c) => String(c.id)).join(', ')} list this address as a hop.
        </p>
      ) : null}
      {warn === undefined ? null : <p class="bad small-text">{warn}</p>}
      {open ? <RouteForm ctx={ctx} entry={entry} /> : null}
    </div>
  )
}
