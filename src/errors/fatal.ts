/**
 * Anything a restart cannot fix. The unit carries
 * `RestartPreventExitStatus=78`, so throwing this is what stops the loop.
 */
export class FatalError extends Error {
  static readonly EXIT_CODE = 78
  /** Bad flags or missing required arguments. */
  static readonly USAGE_EXIT_CODE = 129

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}
