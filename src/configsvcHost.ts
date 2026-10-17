/** Where the config UI is reached: always a loopback listener, plus an HTTPS bridge on `[configsvc] host` when that is not loopback. */

/** The port the Caddy bridge serves the config UI on, on the name `[configsvc] host` gives. */
export const CONFIGSVC_TLS_PORT = 29_444

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const BRIDGE_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/

export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTS.has(host)

/** A name or IPv4 address a client can dial and a Caddy site address can carry; `0.0.0.0` names no one machine. */
export const isBridgeHost = (host: string): boolean =>
  host !== '0.0.0.0' && BRIDGE_HOST_RE.test(host)

/** The `host:port` clients use through the bridge, which is also the `Host` header they send. */
export const bridgeAuthority = (host: string): string => `${host}:${CONFIGSVC_TLS_PORT}`
