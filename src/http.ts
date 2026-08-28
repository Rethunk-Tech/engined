/**
 * One name per HTTP status code this door ever returns, and the one shape
 * every JSON error body takes. A status meaning is decided once here; a
 * caller that reaches for a bare number instead of one of these constants
 * is the bug this file exists to prevent.
 */

export const STATUS_OK = 200;
export const STATUS_BAD_REQUEST = 400;
export const STATUS_FORBIDDEN = 403;
export const STATUS_NOT_FOUND = 404;
export const STATUS_PAYLOAD_TOO_LARGE = 413;
export const STATUS_BAD_GATEWAY = 502;
export const STATUS_UNAVAILABLE = 503;

/** The one JSON error shape, for a caller that builds its own response envelope (`DoorResponse`, `HopResult`) around it. */
export function jsonErrorBody(message: string): { error: string } {
  return { error: message };
}

/** The same shape, already wrapped as a `Response` — for a caller returning straight to the door's own `fetch`. */
export function jsonError(status: number, message: string): Response {
  return Response.json(jsonErrorBody(message), { status });
}

/** A 4xx is the caller's fault rather than the engine's, but the attempt still produced no output, so it is not a success. */
export const HTTP_CLIENT_ERROR_MIN = 400;
export const HTTP_SERVER_ERROR_MIN = 500;
export const HTTP_SERVER_ERROR_MAX = 600;

/** Narrower than `typeof fetch`: Bun's `fetch` type also carries a static `preconnect`, which a plain test double has no reason to fake. */
export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;
