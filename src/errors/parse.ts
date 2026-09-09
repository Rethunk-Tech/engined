import { FatalError } from "./fatal.ts";

/** A fatal parse failure that can name the file and site that caused it. */
export class ParseError extends FatalError {
  readonly file: string;

  constructor(message: string, file: string, options?: ErrorOptions) {
    super(`${file}: ${message}`, options);
    this.file = file;
  }
}
