/**
 * One streamed Anthropic-wire reply, captured 2026-11-11 with `curl -N` from
 * OpenRouter's Anthropic gateway (`openrouter-anthropic`, `/api/v1/messages?beta=true`).
 * Real bytes, not invented: the keyless forwarder has to pass them through
 * unbuffered and unchanged. Each entry is one SSE event, blank-line terminator
 * included, so a fake upstream can hold back the rest after the first.
 */
export const ANTHROPIC_SSE_EVENTS: readonly string[] = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_bdrk_5jtdw3mnp2a73apobaabz3xjgfjanmjbdiyx2uewkyi5fbsxw3ga","type":"message","role":"assistant","container":null,"content":[],"model":"anthropic/claude-haiku-4.5","stop_reason":null,"stop_details":null,"stop_sequence":null,"usage":{"input_tokens":13,"output_tokens":1,"output_tokens_details":null,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"inference_geo":null,"server_tool_use":null,"service_tier":"standard","speed":"standard"},"provider":"Amazon Bedrock"}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"","citations":[]}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"p"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ong"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"container":null,"stop_details":null,"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":13,"output_tokens":5,"output_tokens_details":{"thinking_tokens":0},"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"server_tool_use":null,"service_tier":"standard","speed":"standard","cost":0.000038,"is_byok":false,"cost_details":{"upstream_inference_cost":0.000038,"upstream_inference_prompt_cost":0.000013,"upstream_inference_completions_cost":0.000025}},"context_management":null}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
]

/** The request body that produced `ANTHROPIC_SSE_EVENTS`. */
export const ANTHROPIC_SSE_REQUEST = JSON.stringify({
  model: 'anthropic/claude-haiku-4.5',
  max_tokens: 16,
  stream: true,
  messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
})
