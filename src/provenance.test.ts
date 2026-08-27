import { expect, test } from "bun:test";
import { type Attempt, type CallRecord, recordCall } from "./provenance.ts";

const DURATION_A_MS = 120;
const DURATION_B_MS = 340;
const DURATION_C_MS = 15;
const ATTEMPT_COUNT = 3;

function collectLines(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

test("recordCall: one call with three attempts emits exactly one line carrying all three failure reasons", () => {
  const { lines, write } = collectLines();
  const record: CallRecord = {
    chain: "chat",
    requested: "@/chat/default",
    attempts: [
      {
        engine: "llama-a",
        model: "chat",
        ok: false,
        failure: "connection refused",
        duration_ms: DURATION_A_MS,
      },
      {
        engine: "llama-b",
        model: "chat",
        ok: false,
        failure: "timeout",
        duration_ms: DURATION_B_MS,
      },
      { engine: "llama-c", model: "chat", ok: true, duration_ms: DURATION_C_MS },
    ],
    engine_used: "llama-c",
  };

  recordCall(record, write);

  expect(lines.length).toBe(1);
  const parsed = JSON.parse(lines[0] ?? "");
  expect(parsed.attempts).toHaveLength(ATTEMPT_COUNT);
  expect(parsed.attempts[0].failure).toBe("connection refused");
  expect(parsed.attempts[1].failure).toBe("timeout");
  expect(parsed.attempts[2].ok).toBe(true);
});

test("recordCall: model_reported and model_resident survive as distinct fields when they differ", () => {
  const { lines, write } = collectLines();
  const record: CallRecord = {
    chain: null,
    requested: "@/llama/router-section",
    attempts: [
      {
        engine: "llama-a",
        model: "router-section",
        ok: true,
        duration_ms: DURATION_A_MS,
        model_reported: "router-section",
        model_resident: "qwen3-30b-a3b-q4.gguf",
      },
    ],
    engine_used: "llama-a",
  };

  recordCall(record, write);

  const parsed = JSON.parse(lines[0] ?? "");
  expect(parsed.attempts[0].model_reported).toBe("router-section");
  expect(parsed.attempts[0].model_resident).toBe("qwen3-30b-a3b-q4.gguf");
  expect(parsed.attempts[0].model_reported).not.toBe(parsed.attempts[0].model_resident);
});

test("recordCall: an agentic attempt's version equals the pin that was launched; a non-agentic attempt carries no version field", () => {
  const { lines, write } = collectLines();
  const record: CallRecord = {
    chain: null,
    requested: "claude",
    attempts: [
      { engine: "claude", model: "", ok: true, duration_ms: DURATION_A_MS, version: "1.2.3" },
      { engine: "llama-a", model: "chat", ok: true, duration_ms: DURATION_B_MS },
    ],
    engine_used: "claude",
  };

  recordCall(record, write);

  const parsed = JSON.parse(lines[0] ?? "");
  expect(parsed.attempts[0].version).toBe("1.2.3");
  expect(Object.hasOwn(parsed.attempts[1], "version")).toBe(false);
});

test("recordCall: each attempt carries its own duration_ms", () => {
  const { lines, write } = collectLines();
  const record: CallRecord = {
    chain: "chat",
    requested: "@/chat/default",
    attempts: [
      {
        engine: "llama-a",
        model: "chat",
        ok: false,
        failure: "timeout",
        duration_ms: DURATION_A_MS,
      },
      { engine: "llama-b", model: "chat", ok: true, duration_ms: DURATION_B_MS },
    ],
    engine_used: "llama-b",
  };

  recordCall(record, write);

  const parsed = JSON.parse(lines[0] ?? "");
  expect(parsed.attempts[0].duration_ms).toBe(DURATION_A_MS);
  expect(parsed.attempts[1].duration_ms).toBe(DURATION_B_MS);
});

test("recordCall: a secret spread onto an attempt is dropped from the emitted line", () => {
  const { lines, write } = collectLines();
  const tainted = {
    engine: "llama-a",
    model: "chat",
    ok: false,
    failure: "unauthorized",
    duration_ms: DURATION_A_MS,
    authorization: "Bearer sk-live-do-not-log",
    api_key: "sk-super-secret",
  } as Attempt;
  const record: CallRecord = {
    chain: "chat",
    requested: "@/chat/default",
    attempts: [tainted],
    engine_used: null,
  };

  recordCall(record, write);

  expect(lines[0]).not.toContain("sk-live-do-not-log");
  expect(lines[0]).not.toContain("sk-super-secret");
  expect(lines[0]).not.toContain("authorization");
  expect(lines[0]).not.toContain("api_key");
});
