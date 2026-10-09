/** Thrown by `DockerLifecycle.hold` when `docker stop` fails, so the hold's caller is not told the weights left the pool when they did not. */
export class StopFailedError extends Error {
  constructor(id: string, reason: string) {
    super(`could not stop engine "${id}": ${reason}`)
    this.name = 'StopFailedError'
  }
}
