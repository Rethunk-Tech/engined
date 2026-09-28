/**
 * A launch's single-use nonce: `crypto.randomUUID()` with its dashes stripped
 * -- 32 lowercase hex characters, the shape `main.ts`'s launch-scoped route
 * matches. Every agentic launch hands its child `/openai/v1/<nonce>/...`
 * rather than the plain surface, so a hop resolving back to an agentic engine
 * is refused instead of launching a further child. It lives here rather than
 * at either call site because there are two -- a caller's own dispatch and
 * the registry's round-trip probe -- and a launch minting nothing would be
 * handed the unscoped door.
 */
export function mintLaunchNonce(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/** Path of a launch-scoped OpenAI surface: `/openai/v1/<nonce>/...`. Capture 1 is the nonce; capture 2 is the rest of the path, including the leading slash. */
export const LAUNCH_NONCE_RE = /^\/openai\/v1\/([0-9a-f]{32})(\/.*)$/

/** The door URL handed to one agentic launch: this box, this listen port, this nonce. */
export function launchScopedBaseUrl(port: number, nonce: string): string {
  return `http://127.0.0.1:${port}/openai/v1/${nonce}`
}
