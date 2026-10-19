/**
 * The JSON Schema of `config.toml`, generated from the parser's closed key
 * sets. Every key in a set must have a field here with a description
 * (`configSchema.test.ts` fails otherwise), so a key added to the parser cannot
 * ship undocumented. `config.schema.json` is this module's output, committed
 * for editors (Taplo's `#:schema` directive) and checked equal by the same test.
 */
import {
  DEFAULT_AGENT_TIMEOUT_SECONDS,
  DEFAULT_AGENTIC_CONCURRENCY,
  DEFAULT_CHAT_TIMEOUT_SECONDS,
  DEFAULT_CURSOR_PORT,
  DEFAULT_LISTEN_PORT,
  DEFAULT_STREAM_STALL_SECONDS,
  ID_RE,
} from './config.ts'
import {
  CALLBACK_SECRET_KEYS,
  CHAIN_KEYS,
  CONFIGSVC_KEYS,
  DEFAULT_INVENTORY_REFRESH_SECONDS,
  ENGINE_KEYS,
  MODEL_KEYS,
  POTLUCK_KEYS,
  ROLES,
  ROUTE_KEYS,
  SECRET_KEYS,
  TOP_KEYS,
  UPSTREAM_KEYS,
  VISION_KINDS,
} from './configKeys.ts'
import { DEFAULT_CONFIGSVC_PORT } from './configUpstream.ts'
import { DEFAULT_IDLE_STOP_SECONDS, DEFAULT_READY_TIMEOUT_S } from './engineEntries.ts'
import { EGRESS_RANK, KIND_TRAITS } from './types.ts'

type JsonObject = Record<string, unknown>
interface Field {
  description: string
  schema: JsonObject
}
type Fields = Record<string, Field>

const MAX_TIMER_SECONDS = 2_147_483
const PORT_MAX = 65_535

const str = (description: string, schema: JsonObject = {}): Field => ({
  description,
  schema: { type: 'string', ...schema },
})
const bool = (description: string, dflt?: boolean): Field => ({
  description,
  schema: { type: 'boolean', ...(dflt === undefined ? {} : { default: dflt }) },
})
const positive = (description: string, dflt?: number): Field => ({
  description,
  schema: { type: 'number', exclusiveMinimum: 0, ...(dflt === undefined ? {} : { default: dflt }) },
})
const seconds = (description: string, dflt?: number): Field => ({
  description,
  schema: {
    type: 'number',
    exclusiveMinimum: 0,
    maximum: MAX_TIMER_SECONDS,
    ...(dflt === undefined ? {} : { default: dflt }),
  },
})
const port = (description: string, dflt: number): Field => ({
  description,
  schema: { type: 'integer', minimum: 1, maximum: PORT_MAX, default: dflt },
})
const strings = (description: string): Field => ({
  description,
  schema: { type: 'array', items: { type: 'string' } },
})
const oneOf = (description: string, values: readonly string[]): Field =>
  str(description, { enum: [...values] })
const ref = (description: string, name: string): Field => ({
  description,
  schema: { $ref: `#/$defs/${name}` },
})
const tables = (description: string, name: string): Field => ({
  description,
  schema: { type: 'array', items: { $ref: `#/$defs/${name}` } },
})
const args = (description: string): Field => ({
  description,
  schema: {
    type: 'object',
    additionalProperties: { type: ['string', 'number', 'boolean'] },
  },
})
const DISABLE = bool('Turns this entry off without deleting it.')

const CAPABILITIES: Fields = {
  input: strings('Input modalities this model accepts, for example "text" or "image".'),
  output: strings('Output modalities this model produces.'),
  context_in: positive('Token window for input.'),
  context_out: positive('Token window for output.'),
  reasoning: strings('Reasoning-effort words this model accepts.'),
}

const ENGINE_FIELDS: Fields = {
  id: str('Engine id; also names its state paths, so it may not contain "/" or start with ".".', {
    pattern: ID_RE.source,
  }),
  disable: DISABLE,
  spec_dir: str(
    'Overrides the shipped spec directory. A privilege decision: spec is trusted code.',
  ),
  models_dir: str('Host directory holding this engine’s model files.'),
  models_max: positive(
    'Llama resident-model budget across roles; may not be below the number of keep_resident roles.',
  ),
  idle_stop_seconds: seconds(
    'How long an engine may sit unheld before it stops.',
    DEFAULT_IDLE_STOP_SECONDS,
  ),
  drain_timeout_seconds: seconds(
    'How long a comfy submission waits for the engine to be free before it is refused. Default 15 minutes.',
  ),
  ready_timeout_s: seconds(
    'How long a start may take to pass its readiness probe.',
    DEFAULT_READY_TIMEOUT_S,
  ),
  agent_version: str('Agentic engines: the pinned CLI version, never "latest".'),
  default_model: str(
    'Claude and cursor engines: the route model the models menu marks as default.',
  ),
  model_refresh_seconds: seconds(
    'Claude and cursor engines: how often the provider is asked which models it serves. Default 3600.',
  ),
  kind: oneOf(
    'For an engine that ships no spec directory: which built-in spec it takes.',
    Object.keys(KIND_TRAITS),
  ),
  args: args('Launch parameters for this engine; a route’s own args override them.'),
  devices: strings(
    'Container engines: host devices passed through, replacing the spec’s list. An empty list means none (CPU-only).',
  ),
  env: {
    description:
      'Container engines: environment variables merged over the spec’s; a key replaces the spec’s entry of the same name.',
    schema: { type: 'object', additionalProperties: { type: 'string' } },
  },
  group_add: strings(
    'Container engines: groups added to the container, replacing the spec’s list. An empty list means none.',
  ),
}

const UPSTREAM_FIELDS: Fields = {
  id: str('Upstream id; "local" is reserved for this box and cannot carry base_url or secret.', {
    pattern: ID_RE.source,
  }),
  base_url: str('Where the upstream is reached.'),
  secret: ref('Keyring item whose value authenticates calls to this upstream.', 'secret'),
  egress: oneOf(
    'How far a call to this upstream travels: none (this box), lan or remote.',
    Object.keys(EGRESS_RANK),
  ),
  wire: oneOf('The request shape this upstream speaks.', ['openai', 'anthropic']),
  disable: DISABLE,
  inventory_max_age_seconds: seconds(
    'How long a cached provider model list stays usable; required when a wildcard route names this upstream.',
  ),
  inventory_refresh_seconds: seconds(
    'How often the provider model list is re-fetched; must be less than inventory_max_age_seconds.',
    DEFAULT_INVENTORY_REFRESH_SECONDS,
  ),
  headers: {
    description: 'Extra headers sent on every remote hop; the auth header and Host are refused.',
    schema: { type: 'object', additionalProperties: { type: 'string' } },
  },
  fingerprint: str('A potluck donation’s identity: 64 hex characters.', {
    pattern: '^[0-9a-f]{64}$',
  }),
  monthly_cap_usd: positive(
    'Cost ceiling per UTC month, from the cost the upstream itself reports.',
  ),
  exclude_models: {
    description:
      'Provider model ids made unavailable: globs (* ? ) over the full wire id, or /regex/.',
    schema: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
}

const SECRET_FIELDS: Fields = {
  service: str('Keyring service attribute.'),
  username: str('Keyring username attribute.'),
  header: str('Header that carries the resolved credential.'),
  scheme: str('Auth prefix such as "Bearer"; absent sends the raw value.'),
}

const MODEL_FIELDS: Fields = {
  id: str('Model id that routes name.'),
  ...CAPABILITIES,
}

const ROUTE_FIELDS: Fields = {
  engine: str('Id of the engine this route runs on.'),
  model: str('Model segment of the address; "*" expands the upstream’s catalog.'),
  wire_model: str('The id the upstream knows, sent in place of model.'),
  display_name: str('Human label a client may show; not an address.'),
  upstream: str('Id of the upstream serving this route; absent means local.'),
  filename: str('Model file under the engine’s models_dir.'),
  role: oneOf('Llama role this model fills.', ROLES),
  vision: oneOf(
    'For a vision role: whether the model describes a scene or reads characters.',
    VISION_KINDS,
  ),
  translate: bool('Opts a speech route into the translations verb.'),
  fim: bool('Opts a local llama route into fill-in-the-middle completions.'),
  keep_resident: bool('Load this model at engine start and reload it whenever its role returns.'),
  streaming: bool('Overrides whether this route streams, against the engine spec.'),
  slot_long_threshold: positive('Token count at or above which a request goes to a long slot.'),
  vision_bridge: str(
    'Address of a vision route that captions image attachments for this chat route.',
  ),
  args: args('Launch parameters for this route; they override the engine’s.'),
  strip_params: strings(
    'Caller JSON keys removed from the request body just before this hop is posted upstream.',
  ),
  set_params: args(
    'JSON fields forced onto the request body just before this hop is posted upstream, overriding the caller.',
  ),
  disable: DISABLE,
  ...CAPABILITIES,
}

const CHAIN_FIELDS: Fields = {
  id: str('Chain name callers address.'),
  hops: strings(
    'Ordered fully-qualified route addresses, "@/engine/model" or "@/engine/upstream/model".',
  ),
  disable: DISABLE,
}

const POTLUCK_FIELDS: Fields = {
  callback_url: str('Where a donated upstream’s liveness is reported.'),
  callback_secret: ref('Keyring item holding the callback bearer.', 'callback_secret'),
}

const CALLBACK_SECRET_FIELDS: Fields = {
  service: str('Keyring service attribute.'),
  username: str('Keyring username attribute.'),
}

const CONFIGSVC_FIELDS: Fields = {
  enable: bool('Whether the config web UI may run.', false),
  host: str(
    'Name or address clients dial the config web UI on. It always listens on loopback; a value that is not loopback is served over HTTPS by the engined-tls bridge (restart it after a change).',
    { default: '127.0.0.1' },
  ),
  port: port(
    'Port of the config web UI; must differ from listen_port and cursor_port.',
    DEFAULT_CONFIGSVC_PORT,
  ),
  password_hash: str(
    'Optional static login hash from `engined --hash-password` (argon2id). Absent, the config UI mints a random token on every start and logs its URL.',
    {
      pattern: '^\\$argon2id\\$',
    },
  ),
}

const TOP_FIELDS: Fields = {
  listen_port: port('Port of the door.', DEFAULT_LISTEN_PORT),
  cursor_port: port(
    'Port of the Cursor turn-stream listener; must differ from listen_port.',
    DEFAULT_CURSOR_PORT,
  ),
  chat_timeout_seconds: seconds('Budget for one chat hop.', DEFAULT_CHAT_TIMEOUT_SECONDS),
  agent_timeout_seconds: seconds('Budget for one agentic task.', DEFAULT_AGENT_TIMEOUT_SECONDS),
  stream_stall_seconds: seconds(
    'How long a streamed answer may sit unread by its client before it is aborted.',
    DEFAULT_STREAM_STALL_SECONDS,
  ),
  agentic_concurrency: {
    description: 'Live agentic launches allowed at once; a further call is refused with 429.',
    schema: { type: 'integer', minimum: 1, default: DEFAULT_AGENTIC_CONCURRENCY },
  },
  engine: tables('Engines the door may start or reach.', 'engine'),
  upstream: tables('Where non-local bytes come from.', 'upstream'),
  model: tables('Optional capability declarations for a model id.', 'model'),
  route: tables('Pairings of an engine with an upstream and, where one applies, a model.', 'route'),
  chain: tables('Ordered failover lists of routes.', 'chain'),
  potluck: ref('Where a donated upstream’s liveness is reported.', 'potluck'),
  configsvc: ref('The config web UI’s listener and login; engined only validates it.', 'configsvc'),
}

/** Every closed key set beside the fields that describe it, in the order the schema lists them. */
export const SCHEMA_TABLES: Record<
  string,
  { keys: ReadonlySet<string>; fields: Fields; required: readonly string[] }
> = {
  top: { keys: TOP_KEYS, fields: TOP_FIELDS, required: [] },
  engine: { keys: ENGINE_KEYS, fields: ENGINE_FIELDS, required: ['id'] },
  upstream: { keys: UPSTREAM_KEYS, fields: UPSTREAM_FIELDS, required: ['id', 'egress'] },
  secret: { keys: SECRET_KEYS, fields: SECRET_FIELDS, required: ['service', 'username', 'header'] },
  model: { keys: MODEL_KEYS, fields: MODEL_FIELDS, required: ['id'] },
  route: { keys: ROUTE_KEYS, fields: ROUTE_FIELDS, required: ['engine'] },
  chain: { keys: CHAIN_KEYS, fields: CHAIN_FIELDS, required: ['id', 'hops'] },
  potluck: {
    keys: POTLUCK_KEYS,
    fields: POTLUCK_FIELDS,
    required: ['callback_url', 'callback_secret'],
  },
  callback_secret: {
    keys: CALLBACK_SECRET_KEYS,
    fields: CALLBACK_SECRET_FIELDS,
    required: ['service', 'username'],
  },
  configsvc: { keys: CONFIGSVC_KEYS, fields: CONFIGSVC_FIELDS, required: [] },
}

function tableSchema(name: string): JsonObject {
  const table = SCHEMA_TABLES[name] as (typeof SCHEMA_TABLES)[string]
  const properties: JsonObject = {}
  for (const key of table.keys) {
    const field = table.fields[key] as Field
    properties[key] = { ...field.schema, description: field.description }
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(table.required.length === 0 ? {} : { required: table.required }),
  }
}

export function configSchema(): JsonObject {
  const { top, ...defs } = Object.fromEntries(
    Object.keys(SCHEMA_TABLES).map((name) => [name, tableSchema(name)]),
  )
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'engined config.toml',
    ...top,
    $defs: defs,
  }
}

export function renderConfigSchema(): string {
  return `${JSON.stringify(configSchema(), null, 2)}\n`
}
