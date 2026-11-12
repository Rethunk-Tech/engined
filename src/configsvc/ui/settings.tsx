import { computed } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { editDraft } from './actions.ts'
import { call, fork } from './api.ts'
import { isTable, parseDoc, type Table } from './model.ts'
import { loadSchema } from './schema.ts'
import { draft } from './store.ts'
import { InvalidToml, Prop } from './widgets.tsx'

const SO_THE_UI_KEEPS = ' so the UI keeps running.'
const ENABLE_TRUE = 'enable = true'
const OFF_STOPS_IT_AT =
  ' off stops it at its next start; with no value set, a save from here writes '
const ENABLE = 'enable'
const THE_CONFIG_UI_ITSELF = 'The config UI itself. Turning '
const CONFIG_UI = 'Config UI'
const DOOR = 'Door'
const CLEAR = 'Clear'
const STORE = 'Store'
const POTLUCK = 'Potluck'

const doc = computed(() => parseDoc(draft.value))

const TOP = [
  'listen_port',
  'cursor_port',
  'chat_timeout_seconds',
  'agent_timeout_seconds',
  'stream_stall_seconds',
  'agentic_concurrency',
] as const
const CONFIGSVC = ['enable', 'host', 'port', 'password_hash'] as const

function textOf(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function writePotluck(
  next: { url: string; service: string; username: string },
  had: boolean,
): Promise<boolean> {
  const complete = next.url !== '' && next.service !== '' && next.username !== ''
  if (complete) {
    return editDraft([
      {
        op: 'setKey',
        path: ['potluck'],
        value: {
          callback_url: next.url,
          callback_secret: { service: next.service, username: next.username },
        },
      },
    ])
  }
  return had
    ? editDraft([{ op: 'setKey', path: ['potluck'], value: undefined }])
    : Promise.resolve(true)
}

function PotluckBox({ table }: { table: Table | undefined }) {
  const secret = isTable(table?.callback_secret) ? table.callback_secret : {}
  const [url, setUrl] = useState(textOf(table?.callback_url))
  const [service, setService] = useState(textOf(secret.service))
  const [username, setUsername] = useState(textOf(secret.username))
  const [present, setPresent] = useState<boolean | undefined>(undefined)
  const [value, setValue] = useState('')
  const [result, setResult] = useState<string>()
  const had = table !== undefined
  const named = service !== '' && username !== ''
  const store = async () => {
    try {
      await call('/api/secret', { service, username, value })
      setValue('')
      setResult('stored')
      setPresent(true)
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err))
    }
  }
  const clear = async () => {
    try {
      await call('/api/secret/clear', { service, username })
      setResult('cleared')
      setPresent(false)
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <>
      <h3>{POTLUCK}</h3>
      <div className="form">
        <Prop
          table="potluck"
          name="callback_url"
          value={url === '' ? undefined : url}
          path={['potluck', 'callback_url']}
          commit={(v) => {
            const next = { url: typeof v === 'string' ? v : '', service, username }
            setUrl(next.url)
            fork(writePotluck(next, had))
          }}
        />
        <Prop
          table="callback_secret"
          name="service"
          value={service === '' ? undefined : service}
          path={['potluck', 'callback_secret', 'service']}
          commit={(v) => {
            const next = { url, service: typeof v === 'string' ? v : '', username }
            setService(next.service)
            fork(writePotluck(next, had))
          }}
        />
        <Prop
          table="callback_secret"
          name="username"
          value={username === '' ? undefined : username}
          path={['potluck', 'callback_secret', 'username']}
          commit={(v) => {
            const next = { url, service, username: typeof v === 'string' ? v : '' }
            setUsername(next.username)
            fork(writePotluck(next, had))
          }}
        />
      </div>
      {named ? (
        <div className="argrow">
          {present === undefined ? null : (
            <span className={present ? 'ok' : 'bad'}>
              {present ? 'present in the keyring' : 'missing from the keyring'}
            </span>
          )}
          <input
            type="password"
            autoComplete="off"
            className="secretvalue"
            placeholder="secret value (written to the keyring, never shown again)"
            value={value}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
          <button type="button" className="small" disabled={value === ''} onClick={store}>
            {STORE}
          </button>
          <button type="button" className="small" onClick={() => fork(clear())}>
            {CLEAR}
          </button>
          {result === undefined ? null : <span className="muted small-text">{result}</span>}
        </div>
      ) : null}
    </>
  )
}

export function SettingsView() {
  useEffect(() => {
    fork(loadSchema())
  }, [])
  const parsed = doc.value
  if (parsed === undefined) {
    return <InvalidToml />
  }
  const svc = (parsed.top.configsvc ?? {}) as Table
  return (
    <section>
      <h3>{DOOR}</h3>
      <div className="form">
        {TOP.map((k) => (
          <Prop key={k} table="top" name={k} value={parsed.top[k]} path={[k]} />
        ))}
      </div>
      <h3>{CONFIG_UI}</h3>
      <p className="muted">
        {THE_CONFIG_UI_ITSELF}
        <code>{ENABLE}</code>
        {OFF_STOPS_IT_AT}
        <code>{ENABLE_TRUE}</code>
        {SO_THE_UI_KEEPS}
      </p>
      <div className="form">
        {CONFIGSVC.map((k) => (
          <Prop key={k} table="configsvc" name={k} value={svc[k]} path={['configsvc', k]} />
        ))}
      </div>
      <PotluckBox table={isTable(parsed.top.potluck) ? parsed.top.potluck : undefined} />
    </section>
  )
}
