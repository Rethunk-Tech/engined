/** The closed key sets and enumerations the config parser admits, free of runtime imports so the config UI bundles them too. */

import type { Role, VisionKind } from './types.ts'

export const ROLES: readonly Role[] = ['chat', 'vision', 'embedding', 'rerank']
export const VISION_KINDS: readonly VisionKind[] = ['describe', 'read']

/** Closed sets: a typo'd key would otherwise silently do nothing. */
export const ENGINE_KEYS = new Set([
  'id',
  'disable',
  'spec_dir',
  'models_dir',
  'models_max',
  'idle_stop_seconds',
  'drain_timeout_seconds',
  'ready_timeout_s',
  'agent_version',
  'default_model',
  'model_refresh_seconds',
  'kind',
  'args',
  'devices',
  'group_add',
  'env',
])
export const UPSTREAM_KEYS = new Set([
  'id',
  'base_url',
  'secret',
  'egress',
  'wire',
  'disable',
  'inventory_max_age_seconds',
  'inventory_refresh_seconds',
  'headers',
  'fingerprint',
  'monthly_cap_usd',
  'exclude_models',
])
/** Re-fetch interval when an upstream omits `inventory_refresh_seconds`. */
export const DEFAULT_INVENTORY_REFRESH_SECONDS = 3600
export const SECRET_KEYS = new Set(['service', 'username', 'header', 'scheme'])
export const MODEL_KEYS = new Set([
  'id',
  'input',
  'output',
  'context_in',
  'context_out',
  'reasoning',
])
export const ROUTE_KEYS = new Set([
  'engine',
  'model',
  'wire_model',
  'display_name',
  'upstream',
  'filename',
  'role',
  'vision',
  'translate',
  'fim',
  'keep_resident',
  'streaming',
  'slot_long_threshold',
  'vision_bridge',
  'args',
  'disable',
  'input',
  'output',
  'context_in',
  'context_out',
  'reasoning',
])
export const CHAIN_KEYS = new Set(['id', 'hops', 'disable'])
/** Root of `config.toml`. A typo here is the same class of silent miss as a table typo. */
export const TOP_KEYS = new Set([
  'listen_port',
  'cursor_port',
  'chat_timeout_seconds',
  'agent_timeout_seconds',
  'stream_stall_seconds',
  'agentic_concurrency',
  'engine',
  'upstream',
  'model',
  'route',
  'chain',
  'potluck',
  'configsvc',
])
/** `[potluck]` on the main file: where a donated upstream's liveness is reported. */
export const POTLUCK_KEYS = new Set(['callback_url', 'callback_secret'])
/** `[configsvc]` on the main file: the config web UI's listener and its login. */
export const CONFIGSVC_KEYS = new Set(['enable', 'host', 'port', 'password_hash'])
/** Keyring name for the callback bearer. Not an upstream secret: it has no header of its own. */
export const CALLBACK_SECRET_KEYS = new Set(['service', 'username'])

export const CAPABILITY_FIELDS = [
  'input',
  'output',
  'context_in',
  'context_out',
  'reasoning',
] as const

/** A wildcard route expands a provider catalog, so keys describing one named model are refused on it. */
export const WILDCARD_FORBIDDEN_KEYS = [
  'filename',
  'role',
  'vision',
  'translate',
  'fim',
  'keep_resident',
  'wire_model',
  'slot_long_threshold',
  'vision_bridge',
  'args',
] as const
