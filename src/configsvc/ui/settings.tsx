import { computed } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { parseDoc, type Table } from './model.ts'
import { loadSchema } from './schema.ts'
import { draft } from './store.ts'
import { Prop } from './widgets.tsx'

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

export function SettingsView() {
  useEffect(() => {
    void loadSchema()
  }, [])
  const parsed = doc.value
  if (parsed === undefined) {
    return <p class="bad">The pending text is not valid TOML; fix it on the Raw TOML view first.</p>
  }
  const svc = (parsed.top.configsvc ?? {}) as Table
  return (
    <section>
      <h2>Settings</h2>
      <h3>Door</h3>
      <div class="form">
        {TOP.map((k) => (
          <Prop key={k} table="top" name={k} value={parsed.top[k]} path={[k]} />
        ))}
      </div>
      <h3>Config UI</h3>
      <p class="muted">
        The config UI itself. Turning <code>enable</code> off stops it at its next start; with no
        value set, a save from here writes <code>enable = true</code> so the UI keeps running.
      </p>
      <div class="form">
        {CONFIGSVC.map((k) => (
          <Prop key={k} table="configsvc" name={k} value={svc[k]} path={['configsvc', k]} />
        ))}
      </div>
    </section>
  )
}
