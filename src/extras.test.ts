import { expect, test } from "bun:test";
import { proxyExtras } from "./extras.ts";
import type { HttpClient } from "./http.ts";

const BASE = "http://127.0.0.1:9999";

function recordingClient(handler: (url: string, init?: RequestInit) => Response): {
  client: HttpClient;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client: HttpClient = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return { client, calls };
}

test("POST /tokenize with no model in the body gets the resident injected", async () => {
  const { client, calls } = recordingClient(() => Response.json({ tokens: [1, 2, 3] }));
  const req = new Request(`${BASE}/tokenize`, {
    method: "POST",
    body: JSON.stringify({ content: "hi" }),
  });
  const res = await proxyExtras(req, BASE, "ornith", client);

  expect(res.status).toBe(200);
  const sentBody = calls[0]?.init?.body;
  expect(typeof sentBody).toBe("string");
  const parsed = JSON.parse(sentBody as string) as { model?: string; content?: string };
  expect(parsed.model).toBe("ornith");
  expect(parsed.content).toBe("hi");
});

test("a model already present in the body is never overridden", async () => {
  const { client, calls } = recordingClient(() => Response.json({ tokens: [] }));
  const req = new Request(`${BASE}/detokenize`, {
    method: "POST",
    body: JSON.stringify({ tokens: [1], model: "explicit" }),
  });
  await proxyExtras(req, BASE, "ornith", client);

  const parsed = JSON.parse(calls[0]?.init?.body as string) as { model?: string };
  expect(parsed.model).toBe("explicit");
});

test("GET /slots with no model query param gets the resident injected", async () => {
  const { client, calls } = recordingClient(() => Response.json([]));
  const req = new Request(`${BASE}/slots`, { method: "GET" });
  await proxyExtras(req, BASE, "ornith", client);

  const sentUrl = new URL(calls[0]?.url ?? "");
  expect(sentUrl.pathname).toBe("/slots");
  expect(sentUrl.searchParams.get("model")).toBe("ornith");
});

test("GET /slots/:id passes through untouched -- no model added", async () => {
  const { client, calls } = recordingClient(() => Response.json({ id: 3 }));
  const req = new Request(`${BASE}/slots/3`, { method: "GET" });
  await proxyExtras(req, BASE, "ornith", client);

  const sentUrl = new URL(calls[0]?.url ?? "");
  expect(sentUrl.pathname).toBe("/slots/3");
  expect(sentUrl.searchParams.has("model")).toBe(false);
});

test("POST /models/load passes its body through unmodified", async () => {
  const { client, calls } = recordingClient(() => Response.json({ status: "loading" }));
  const req = new Request(`${BASE}/models/load`, {
    method: "POST",
    body: JSON.stringify({ model: "ornith" }),
  });
  await proxyExtras(req, BASE, "ornith", client);

  const parsed = JSON.parse(calls[0]?.init?.body as string) as { model?: string };
  expect(parsed.model).toBe("ornith");
  expect(Object.keys(parsed)).toEqual(["model"]);
});

test("the upstream response body passes through unmodified, SSE included", async () => {
  const sseBody = 'data: {"content":"a","timings":{"predicted_ms":1},"timings_per_token":{}}\n\n';
  const { client } = recordingClient(
    () => new Response(sseBody, { headers: { "content-type": "text/event-stream" } }),
  );
  const req = new Request(`${BASE}/apply-template`, {
    method: "POST",
    body: JSON.stringify({ messages: [] }),
  });
  const res = await proxyExtras(req, BASE, "ornith", client);

  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(await res.text()).toBe(sseBody);
});

test("no resident model: injectable endpoints are forwarded without a model, letting the upstream 400", async () => {
  const { client, calls } = recordingClient(() => new Response(null, { status: 400 }));
  const req = new Request(`${BASE}/tokenize`, {
    method: "POST",
    body: JSON.stringify({ content: "hi" }),
  });
  const res = await proxyExtras(req, BASE, null, client);

  expect(res.status).toBe(400);
  const parsed = JSON.parse(calls[0]?.init?.body as string) as { model?: string };
  expect(parsed.model).toBeUndefined();
});
