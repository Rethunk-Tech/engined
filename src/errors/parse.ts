import { FatalError } from './fatal.ts'

/** A fatal parse failure; the message already names the file that caused it. */
export class ParseError extends FatalError {
  constructor(message: string, file: string, options?: ErrorOptions) {
    super(`${file}: ${message}`, options)
  }
}
