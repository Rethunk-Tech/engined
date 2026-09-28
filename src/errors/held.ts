import { MS_PER_SECOND } from '../records.ts'

/**
 * Thrown by `DockerLifecycle.start` while a hold still stands. A distinct
 * class rather than a plain `Error` so every door maps it to 503 without
 * parsing a message.
 */
export class HeldError extends Error {
  constructor(id: string, heldMs: number) {
    super(
      `engine "${id}" is held for another ${Math.ceil(heldMs / MS_PER_SECOND)}s; whatever took the hold wants this engine's memory`,
    )
    this.name = 'HeldError'
  }
}
