/**
 * The only module that reads runtime environment in shipped code. Tests may still
 * touch `process.env` under the test override; production routes through here.
 */
export const ambientEnv: NodeJS.ProcessEnv = Bun.env

export function envString(name: string): string | undefined {
  return Bun.env[name]
}

export function pathSearchPath(): string | undefined {
  return Bun.env.PATH
}
