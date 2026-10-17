import { FatalError } from './fatal.ts'

/** Where in the config a fault is: the file, then the table entry (`index` counts within that file) and key when known. */
export interface ConfigPath {
  file: string
  table?: string
  index?: number
  key?: string
}

/** A fatal parse failure; the message already names the file that caused it. */
export class ParseError extends FatalError {
  /** Set where the throw site knows the entry or key; message text never depends on it. */
  path?: ConfigPath

  constructor(message: string, file: string, options?: ErrorOptions)
  constructor(message: string, path: ConfigPath | undefined, options?: ErrorOptions)
  constructor(message: string, options?: ErrorOptions & { path?: ConfigPath })
  constructor(
    message: string,
    second?: string | ConfigPath | (ErrorOptions & { path?: ConfigPath }),
    third?: ErrorOptions,
  ) {
    if (typeof second === 'string') {
      super(`${second}: ${message}`, third)
      this.path = { file: second }
    } else if (second !== undefined && 'file' in second) {
      super(`${second.file}: ${message}`, third)
      this.path = second
    } else {
      super(message, second)
      this.path = second?.path
    }
  }
}
