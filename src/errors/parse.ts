import { FatalError } from './fatal.ts'

/** A fatal parse failure; the message already names the file that caused it. */
export class ParseError extends FatalError {
  constructor(message: string, file: string, options?: ErrorOptions)
  constructor(message: string, options?: ErrorOptions)
  constructor(message: string, fileOrOptions?: string | ErrorOptions, options?: ErrorOptions) {
    if (typeof fileOrOptions === 'string') {
      super(`${fileOrOptions}: ${message}`, options)
    } else {
      super(message, fileOrOptions)
    }
  }
}
