/** The desktop keyring as the config UI uses it: presence checks, stores and clears, all under engined's own prefix. */
import { clearSecret, resolveSecret, storeSecret } from './secrets.ts'

export interface SecretTool {
  /** Whether the item resolves. The value itself is dropped. */
  present: (service: string, username: string) => Promise<boolean>
  store: (
    service: string,
    username: string,
    value: string,
  ) => Promise<{ ok: boolean; error?: string }>
  clear: (service: string, username: string) => Promise<{ ok: boolean; error?: string }>
}

export const secretTool: SecretTool = {
  present: async (service, username) => (await resolveSecret({ service, username })).ok,
  store: (service, username, value) => storeSecret({ service, username }, value),
  clear: (service, username) => clearSecret({ service, username }),
}
