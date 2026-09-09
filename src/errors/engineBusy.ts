/**
 * Thrown by `EngineRegistry.start` when a model switch would kill requests
 * mid-flight: a warm is an optimization, and stopping a container to satisfy
 * one is strictly worse than warming late. A distinct class rather than a
 * plain `Error` so a caller can map it to 409 without parsing a message.
 */
export class EngineBusyError extends Error {}
