import { version as ENGINED_VERSION } from '../../../package.json' with { type: 'json' }
import { status, statusFault } from './store.ts'

export function AboutView() {
  const door = status.value
  const fault = statusFault.value
  return (
    <section>
      <div class="panel">
        <h3>engined</h3>
        <p>{ENGINED_VERSION}</p>
        {door?.commit === undefined ? null : <p class="muted">commit {door.commit}</p>}
        {door?.contract === undefined ? null : <p class="muted">contract {door.contract}</p>}
        {fault === undefined ? null : <p class="muted">The door did not answer: {fault}</p>}
        <p>
          <a href="https://github.com/Rethunk-Tech/engined">
            https://github.com/Rethunk-Tech/engined
          </a>
        </p>
      </div>
    </section>
  )
}
