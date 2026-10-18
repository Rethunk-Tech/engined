/** `engined --caddyfile TEMPLATE OUT`: the Cursor bridge's Caddyfile, plus a site for the config UI when `[configsvc] host` is not loopback. */
import { readFileSync, writeFileSync } from 'node:fs'
import { loadConfig } from './config.ts'
import {
  BRIDGE_HOP_HEADER,
  CONFIGSVC_TLS_PORT,
  ensureBridgeHop,
  isLoopbackHost,
} from './configsvcHost.ts'
import { errMessage } from './records.ts'

const CONFIGSVC_SITE_MARKER = '# @CONFIGSVC_SITE@'

/** The template with its marker replaced by the config UI's HTTPS site, or left as the comment it is. */
export function renderCaddyfile(
  template: string,
  configsvc: { host: string; port: number; hop: string } | undefined,
): string {
  if (configsvc === undefined) {
    return template
  }
  // Caddy passes the client's Host through, which is what the config UI checks against its bridged name.
  // The hop header is the authenticating mark: X-Forwarded-For is ignored without it.
  const site = [
    '# The config UI listens on loopback only; this site is its LAN door.',
    `https://${configsvc.host}:${CONFIGSVC_TLS_PORT} {`,
    '\ttls internal',
    `\treverse_proxy 127.0.0.1:${configsvc.port} {`,
    `\t\theader_up ${BRIDGE_HOP_HEADER} ${configsvc.hop}`,
    '\t}',
    '}',
  ].join('\n')
  return template.replace(CONFIGSVC_SITE_MARKER, site)
}

/** The bridged name and loopback port from the live config; none when it is loopback, disabled, or does not load. */
function configsvcSite(
  write: (line: string) => void,
): { host: string; port: number; hop: string } | undefined {
  try {
    const { configsvc } = loadConfig()
    return configsvc.enable && !isLoopbackHost(configsvc.host)
      ? { host: configsvc.host, port: configsvc.port, hop: ensureBridgeHop() }
      : undefined
  } catch (err) {
    write(`caddyfile: config does not load, rendering the Cursor door only: ${errMessage(err)}`)
    return undefined
  }
}

export function caddyfileExit(args: readonly string[], write: (line: string) => void): number {
  const [template, out] = args
  if (template === undefined || out === undefined) {
    write('usage: engined --caddyfile TEMPLATE OUT')
    return 2
  }
  writeFileSync(out, renderCaddyfile(readFileSync(template, 'utf8'), configsvcSite(write)))
  return 0
}
