import { version as ENGINED_VERSION } from '../../../package.json' with { type: 'json' }
import { status, statusFault } from './store.ts'

const TITLE = 'engined'
const COMMIT_PREFIX = 'commit '
const CONTRACT_PREFIX = 'contract '
const DOOR_SILENCE = 'The door did not answer: '
const REPO_URL = 'https://github.com/Rethunk-Tech/engined'

export function AboutView() {
  const door = status.value
  const fault = statusFault.value
  return (
    <section>
      <div className="panel">
        <h3>{TITLE}</h3>
        <p>{ENGINED_VERSION}</p>
        {door?.commit === undefined ? null : (
          <p className="muted">
            {COMMIT_PREFIX}
            {door.commit}
          </p>
        )}
        {door?.contract === undefined ? null : (
          <p className="muted">
            {CONTRACT_PREFIX}
            {door.contract}
          </p>
        )}
        {fault === undefined ? null : (
          <p className="muted">
            {DOOR_SILENCE}
            {fault}
          </p>
        )}
        <p>
          <a href="https://github.com/Rethunk-Tech/engined">{REPO_URL}</a>
        </p>
      </div>
    </section>
  )
}
