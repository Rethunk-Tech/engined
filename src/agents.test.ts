/**
 * The two envelope parsers, against output measured from the real binaries
 * rather than invented -- opencode 1.18.25 pointed at engined's own door, and
 * the same launch against a dead upstream for the failure shape.
 */
import { expect, it } from "bun:test";
import { AGENT_IDS, agentCli, parseClaudeEnvelope, parseOpencodeEvents } from "./agents.ts";
import { AGENTIC_FLOOR } from "./types.ts";

/** Captured verbatim: `opencode run --format json "Reply with exactly the word: pong"`. */
const OPENCODE_OK = [
  '{"type":"step_start","timestamp":1788076641319,"sessionID":"ses_x","part":{"id":"prt_a","messageID":"msg_a","sessionID":"ses_x","type":"step-start"}}',
  '{"type":"text","timestamp":1788076641743,"sessionID":"ses_x","part":{"id":"prt_b","messageID":"msg_a","sessionID":"ses_x","type":"text","text":"pong","time":{"start":1,"end":2}}}',
  '{"type":"step_finish","timestamp":1788076641743,"sessionID":"ses_x","part":{"id":"prt_c","reason":"stop","messageID":"msg_a","sessionID":"ses_x","type":"step-finish","tokens":{"total":11244,"input":11226,"output":18,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}',
].join("\n");

/** Captured verbatim against a port nothing was listening on. opencode also exited 1, which is not consulted. */
const OPENCODE_ERR =
  '{"type":"error","timestamp":1788076739979,"sessionID":"ses_y","error":{"name":"APIError","data":{"message":"Cannot connect to API: Unable to connect. Is the computer able to access the url?","isRetryable":true,"metadata":{"url":"http://127.0.0.1:29999/openai/v1/chat/completions"}}}}';

it("reads opencode's answer out of the text events, which arrive one per chunk", () => {
  expect(parseOpencodeEvents(OPENCODE_OK)).toEqual({ ok: true, result: "pong" });
});

it("joins the text events in order rather than taking only the last", () => {
  const split = OPENCODE_OK.replace('"text":"pong"', '"text":"po"').concat(
    "\n",
    '{"type":"text","part":{"type":"text","text":"ng"}}',
  );
  expect(parseOpencodeEvents(split).result).toBe("pong");
});

it("reports the API error's own message, not the event name", () => {
  const out = parseOpencodeEvents(OPENCODE_ERR);
  expect(out.ok).toBe(false);
  expect(out.failure).toContain("Cannot connect to API");
});

it("an error event fails the call even when text was printed before it", () => {
  const out = parseOpencodeEvents(`${OPENCODE_OK}\n${OPENCODE_ERR}`);
  expect(out.ok).toBe(false);
  // The partial answer is still handed back, the way a claude envelope failure carries its result.
  expect(out.result).toBe("pong");
});

it("a stream that finished without an answer is a failure, not an empty success", () => {
  const noText = OPENCODE_OK.split("\n")
    .filter((l) => !l.includes('"type":"text"'))
    .join("\n");
  expect(parseOpencodeEvents(noText).ok).toBe(false);
});

it("stdout that is not events at all is a failure naming that, never a silent empty result", () => {
  expect(parseOpencodeEvents("").ok).toBe(false);
  expect(parseOpencodeEvents("Segmentation fault\n").failure).toContain("parseable JSON events");
});

it("claude's envelope still parses, and is_error still beats a populated result", () => {
  expect(parseClaudeEnvelope('{"result":"hi"}')).toEqual({ ok: true, result: "hi" });
  const lying = parseClaudeEnvelope(
    '{"is_error":true,"subtype":"success","terminal_reason":"api_error","result":"Not logged in"}',
  );
  expect(lying.ok).toBe(false);
  expect(lying.failure).toContain("api_error");
});

it("claude carries the read-only floor in its launch argv and opencode carries none", () => {
  const claude = agentCli("claude");
  const opencode = agentCli("opencode");
  expect(claude?.floor).toBe("flags");
  expect(claude?.launch("/mcp.json")).toEqual([
    "-p",
    "--output-format",
    "json",
    ...AGENTIC_FLOOR,
    "/mcp.json",
  ]);
  // Not an oversight: opencode has no tool or permission flag to be given, so
  // its floor is the sandbox and its argv says nothing about one.
  expect(opencode?.floor).toBe("sandbox");
  expect(opencode?.launch("/mcp.json")).toEqual(["run", "--format", "json"]);
});

it("an unknown agent resolves to nothing, so the spec parser can refuse it by name", () => {
  expect(agentCli("codex")).toBeUndefined();
  expect(AGENT_IDS).toEqual(["claude", "opencode"]);
});
