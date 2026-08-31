/**
 * The remote proxy: a configured address plus one keyring header, and the
 * two doors that speak through it. Every upstream here is a real
 * `Bun.serve`, and each one records the requests it actually received —
 * a status code alone never proves the wire shape was right.
 */

import { expect, test } from "bun:test";
import { handleSpeech, handleTranscription } from "./audio.ts";
import type { Exec as SecretExec } from "./exec.ts";
import { createDoor, type Door } from "./main.ts";
import { isRemote, remoteUrl, resolveRemote, upstreamPath } from "./remote.ts";
import type { Config, EngineEntry } from "./types.ts";

const TEST_LISTEN_PORT = 39_218;
const SAMPLE_WAV = new Uint8Array(Buffer.from("RIFF____WAVEfmt ", "utf8"));
const SECRET_VALUE = "sk-not-a-real-key";

const SECRET_REF = { service: "svc", username: "user", header: "xi-api-key" } as const;

/** `secret-tool lookup` that finds the entry. Never the real keyring. */
const foundSecret: SecretExec = async () => ({
  stdout: `${SECRET_VALUE}\n`,
  stderr: "",
  exitCode: 0,
});

/** A clean "no such item": `secret-tool` prints nothing on either stream. */
const missingSecret: SecretExec = async () => ({ stdout: "", stderr: "", exitCode: 1 });

function remoteEngine(overrides: Partial<EngineEntry> = {}): EngineEntry {
  return {
    id: "elevenlabs",
    egress: "remote",
    kind: "stt",
    base_url: "https://api.elevenlabs.io/v1",
    secret: { ...SECRET_REF },
    args: {},
    ...overrides,
  };
}

test("remoteUrl keeps the base URL's own path, which new URL() would discard", () => {
  expect(remoteUrl("https://api.elevenlabs.io/v1", "/speech-to-text")).toBe(
    "https://api.elevenlabs.io/v1/speech-to-text",
  );
  expect(remoteUrl("https://api.kimi.com/coding/", "/openai/v1/chat/completions")).toBe(
    "https://api.kimi.com/coding/openai/v1/chat/completions",
  );
});

test("upstreamPath drops the door's own /v1, which every base_url already carries", () => {
  expect(upstreamPath("/openai/v1/chat/completions")).toBe("/chat/completions");
  expect(upstreamPath("/openai/v1/embeddings")).toBe("/embeddings");
  // Not a prefix match on the string: an upstream path that merely starts
  // with those two characters keeps them.
  expect(upstreamPath("/v1beta/models")).toBe("/v1beta/models");
});

test("isRemote is base_url and nothing else", () => {
  expect(isRemote(remoteEngine())).toBe(true);
  expect(isRemote({ id: "local-llama", egress: "none", args: {} })).toBe(false);
});

test("resolveRemote projects the secret into exactly the header config named", async () => {
  const resolution = await resolveRemote(remoteEngine(), foundSecret);
  expect(resolution.ok).toBe(true);
  if (!resolution.ok) {
    return;
  }
  expect(resolution.endpoint.headers).toEqual({ "xi-api-key": SECRET_VALUE });
  expect(resolution.endpoint.base_url).toBe("https://api.elevenlabs.io/v1");
});

test("a remote engine with no secret is a 502 -- misconfigured, not merely unavailable", async () => {
  const resolution = await resolveRemote(remoteEngine({ secret: undefined }), foundSecret);
  expect(resolution.ok).toBe(false);
  if (resolution.ok) {
    return;
  }
  expect(resolution.status).toBe(502);
});

test("a missing keyring entry is a 503 carrying the runnable secret-tool fix", async () => {
  const resolution = await resolveRemote(remoteEngine(), missingSecret);
  expect(resolution.ok).toBe(false);
  if (resolution.ok) {
    return;
  }
  expect(resolution.status).toBe(503);
  expect(resolution.error).toContain("secret-tool store");
});

interface RecordedForm {
  modelId: string | null;
  languageCode: string | null;
  apiKey: string | null;
  path: string;
}

/** A real ElevenLabs-shaped upstream: `/speech-to-text`, multipart in, `{text}` out. */
function startFakeElevenLabs(recorded: RecordedForm[]): { base: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const form = await req.formData();
      recorded.push({
        path: url.pathname,
        modelId: form.get("model_id") as string | null,
        languageCode: form.get("language_code") as string | null,
        apiKey: req.headers.get("xi-api-key"),
      });
      return Response.json({
        language_code: "eng",
        language_probability: 0.99,
        text: "the cutover is finished",
        words: [],
      });
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

test("a remote STT engine posts ElevenLabs' own shape and unwraps its transcript", async () => {
  const recorded: RecordedForm[] = [];
  const fake = startFakeElevenLabs(recorded);
  try {
    const resolution = await resolveRemote(
      remoteEngine({ base_url: fake.base, args: { model_id: "scribe_v1_experimental" } }),
      foundSecret,
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      return;
    }
    const result = await handleTranscription(
      {
        model: "elevenlabs",
        file: SAMPLE_WAV,
        language: "en",
        response_format: "text",
      },
      async () => ({ private_url: null, remote: resolution.endpoint }),
    );

    expect(result.status).toBe(200);
    expect(result.contentType).toBe("text/plain");
    expect(result.body).toBe("the cutover is finished");
    expect(recorded).toHaveLength(1);
    // The upstream's own field names, not the door's: `model_id`, not
    // `model`; `language_code`, not `language`.
    expect(recorded[0]?.path).toBe("/speech-to-text");
    expect(recorded[0]?.modelId).toBe("scribe_v1_experimental");
    expect(recorded[0]?.languageCode).toBe("en");
    expect(recorded[0]?.apiKey).toBe(SECRET_VALUE);
  } finally {
    fake.stop();
  }
});

test("a remote STT engine without a configured model_id still sends one", async () => {
  const recorded: RecordedForm[] = [];
  const fake = startFakeElevenLabs(recorded);
  try {
    const resolution = await resolveRemote(remoteEngine({ base_url: fake.base }), foundSecret);
    if (!resolution.ok) {
      throw new Error("expected the fake secret to resolve");
    }
    const result = await handleTranscription(
      { model: "elevenlabs", file: SAMPLE_WAV },
      async () => ({
        private_url: null,
        remote: resolution.endpoint,
      }),
    );

    expect(result.status).toBe(200);
    // Absent `response_format` is the door's JSON shape, carrying only
    // `text` -- never the upstream's word timings, which would appear and
    // disappear with the engine id.
    expect(result.body).toEqual({ text: "the cutover is finished" });
    expect(recorded[0]?.modelId).toBe("scribe_v1");
  } finally {
    fake.stop();
  }
});

test("a remote engine whose secret will not resolve reports the fix, not 'not available'", async () => {
  const result = await handleTranscription({ model: "elevenlabs", file: SAMPLE_WAV }, async () => {
    const resolution = await resolveRemote(remoteEngine(), missingSecret);
    return resolution.ok
      ? { private_url: null, remote: resolution.endpoint }
      : { private_url: null, unavailable: resolution.error };
  });
  expect(result.status).toBe(503);
  expect(JSON.stringify(result.body)).toContain("secret-tool store");
});

test("the speech door says so rather than pretending a remote engine failed to start", async () => {
  const result = await handleSpeech({ model: "elevenlabs", input: "hello" }, async () => ({
    private_url: null,
    remote: { base_url: "https://x", headers: {}, args: {} },
  }));
  expect(result.status).toBe(502);
  expect(JSON.stringify(result.body)).toContain("no remote speech dialect ships");
});

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    listen_port: TEST_LISTEN_PORT,
    chat_timeout_seconds: 30,
    agent_timeout_seconds: 60,
    models: [],
    engines: [],
    chains: {},
    ...overrides,
  };
}

interface RecordedChat {
  body: Record<string, unknown>;
  apiKey: string | null;
  path: string;
}

function startFakeOpenAiUpstream(recorded: RecordedChat[]): { base: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      recorded.push({
        path: url.pathname,
        apiKey: req.headers.get("x-api-key"),
        body: (await req.json()) as Record<string, unknown>,
      });
      return Response.json({
        model: "upstream-model-7",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
        ],
      });
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function remoteChatConfig(base: string, engineArgs: Record<string, unknown> = {}): Config {
  return baseConfig({
    models: [{ id: "upstream-model-7", engine: "hosted", aliases: [], args: {} }],
    engines: [
      {
        id: "hosted",
        egress: "remote",
        kind: "openai-http",
        base_url: `${base}/v1`,
        secret: { service: "svc", username: "user", header: "x-api-key" },
        args: engineArgs,
      },
    ],
    chains: { "chain-private": ["@/hosted/upstream-model-7"] },
  });
}

function chatRequest(body: unknown): Request {
  return new Request(`http://127.0.0.1:${TEST_LISTEN_PORT}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Every remote-proxy test stands up the same fake upstream and door, then tears both down; only the request and assertions differ. */
async function withRemoteDoor(
  fn: (door: Door, recorded: RecordedChat[]) => Promise<void>,
  engineArgs: Record<string, unknown> = {},
): Promise<void> {
  const recorded: RecordedChat[] = [];
  const fake = startFakeOpenAiUpstream(recorded);
  const door = createDoor(
    remoteChatConfig(fake.base, engineArgs),
    { enginesRoot: "/nonexistent/engines", bunx: "/opt/test/bunx" },
    { secretExec: foundSecret },
  );
  try {
    await fn(door, recorded);
  } finally {
    fake.stop();
    await door.registry.shutdown();
  }
}

test("a remote openai-http engine is proxied with its header, its model id, and no door fields", async () => {
  await withRemoteDoor(async (door, recorded) => {
    const res = await door.fetch(
      chatRequest({
        model: "upstream-model-7",
        workdir: "/tmp/should-not-travel",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(res.status).toBe(200);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.path).toBe("/v1/chat/completions");
    expect(recorded[0]?.apiKey).toBe(SECRET_VALUE);
    expect(recorded[0]?.body.model).toBe("upstream-model-7");
    // engined's own door fields are not this provider's request fields.
    expect(recorded[0]?.body).not.toHaveProperty("workdir");
    expect(recorded[0]?.body).not.toHaveProperty("local_only");
  });
});

test("local_only never reaches a remote engine -- the upstream records no request at all", async () => {
  await withRemoteDoor(async (door, recorded) => {
    const res = await door.fetch(
      chatRequest({
        model: "chain-private",
        local_only: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(res.status).not.toBe(200);
    expect(recorded).toHaveLength(0);
  });
});

test("a caller's explicit null unsets an [engine.args] wire default", async () => {
  await withRemoteDoor(
    async (door, recorded) => {
      const res = await door.fetch(
        chatRequest({
          model: "upstream-model-7",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: null,
        }),
      );
      expect(res.status).toBe(200);
      expect(recorded).toHaveLength(1);
      // Not forwarded as null either: the key is gone, which is what a vendor
      // answering 400 for that parameter needs on the retry.
      expect("reasoning_effort" in (recorded[0]?.body ?? {})).toBe(false);
    },
    { reasoning_effort: "medium" },
  );
});

test("an [engine.args] default still fills a key the caller left out", async () => {
  await withRemoteDoor(
    async (door, recorded) => {
      await door.fetch(
        chatRequest({ model: "upstream-model-7", messages: [{ role: "user", content: "hi" }] }),
      );
      expect(recorded[0]?.body.reasoning_effort).toBe("medium");
    },
    { reasoning_effort: "medium" },
  );
});
