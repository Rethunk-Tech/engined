import { expect, test } from "bun:test";
import { type HopExec, type RunChainOptions, runChain } from "./chain.ts";
import type { Egress } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 2000;
const HOP_ENGINE = /^@\//;

function engineOf(hop: string): string {
  return hop.replace(HOP_ENGINE, "").split("/")[0] ?? hop;
}

interface Behavior {
  status: number;
  body?: string;
  contentType?: string;
  delayMs?: number;
}

/** One `Bun.serve` fake upstream shared by every hop in a test; `requestLog` is the only proof a hop was never called. */
function startFakeUpstream(behaviors: Record<string, Behavior>): {
  base: string;
  requestLog: string[];
  stop: () => void;
} {
  const requestLog: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const engine = new URL(req.url).pathname.slice(1);
      requestLog.push(engine);
      const behavior = behaviors[engine];
      if (!behavior) {
        return new Response("no route", { status: 404 });
      }
      if (behavior.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      }
      return new Response(behavior.body ?? "", {
        status: behavior.status,
        headers: behavior.contentType ? { "content-type": behavior.contentType } : undefined,
      });
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, requestLog, stop: () => server.stop(true) };
}

/** A port nothing listens on: bind an ephemeral one and close it immediately. */
function deadPort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const { port } = probe;
  probe.stop(true);
  if (port === undefined) {
    throw new Error("Bun.serve did not report a port");
  }
  return port;
}

/**
 * A raw socket, not `Bun.serve`: emits one chunked-encoding frame with no
 * terminating `0\r\n\r\n` and cuts the connection, the same truncated-body
 * shape a dropped upstream connection leaves. `Bun.serve` recomputes
 * `content-length` from what a stream actually sends, so it cannot fake this.
 */
function startFlakyStreamUpstream(): { base: string; stop: () => void } {
  const chunk = "data: partial\n\n";
  const chunkLen = new TextEncoder().encode(chunk).length;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunkLen.toString(16)}\r\n${chunk}\r\n`,
        );
        setTimeout(() => socket.terminate(), 5);
      },
      data() {
        // Nothing to read: this socket only ever writes.
      },
      close() {
        // The abrupt close is the point of this fake; nothing to react to.
      },
      error() {
        // Bun.listen requires a handler; the test asserts on the client's side of the drop.
      },
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function makeExec(bases: Record<string, string>): HopExec {
  return async (hop, signal) => {
    const engine = engineOf(hop);
    const base = bases[engine];
    if (base === undefined) {
      throw new Error(`test exec: no route registered for ${engine}`);
    }
    const res = await fetch(`${base}/${engine}`, { signal });
    if (res.headers.get("content-type") === "text/event-stream") {
      return { status: res.status, stream: res.body ?? undefined, startedBytes: true };
    }
    return { status: res.status, body: await res.text(), startedBytes: false };
  };
}

function collectLines(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

function baseOpts(
  overrides: Partial<RunChainOptions> & Pick<RunChainOptions, "exec">,
): RunChainOptions {
  return {
    chain: "test-chain",
    requested: "chain-test-chain",
    localOnly: false,
    egressOf: () => "remote",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...overrides,
  };
}

test("first hop at a dead port completes on the second, and provenance names the second engine", async () => {
  const up = startFakeUpstream({
    good: { status: 200, body: "answer", contentType: "text/plain" },
  });
  const { lines, write } = collectLines();
  const dead = deadPort();

  const result = await runChain(
    ["@/dead/model", "@/good/model"],
    baseOpts({ exec: makeExec({ dead: `http://127.0.0.1:${dead}`, good: up.base }), write }),
  );
  up.stop();

  expect(result.status).toBe(200);
  expect(result.engineUsed).toBe("good");
  const record = JSON.parse(lines[0] ?? "");
  expect(record.engine_used).toBe("good");
  expect(record.attempts).toHaveLength(2);
  expect(record.attempts[0].engine).toBe("dead");
  expect(record.attempts[0].ok).toBe(false);
});

test("a 4xx on hop 1 does not advance: hop 2 is never invoked", async () => {
  const up = startFakeUpstream({
    badreq: { status: 400, body: "bad request", contentType: "text/plain" },
    unused: { status: 200, body: "should never be seen" },
  });

  const result = await runChain(
    ["@/badreq/model", "@/unused/model"],
    baseOpts({ exec: makeExec({ badreq: up.base, unused: up.base }) }),
  );
  up.stop();

  expect(result.status).toBe(400);
  expect(up.requestLog).not.toContain("unused");
});

test("a 5xx, a connection failure, and an empty body each advance to the next hop", async () => {
  const up = startFakeUpstream({
    servererr: { status: 500, body: "boom", contentType: "text/plain" },
    empty: { status: 200, body: "", contentType: "text/plain" },
    success: { status: 200, body: "answer", contentType: "text/plain" },
  });
  const dead = deadPort();

  const result = await runChain(
    ["@/servererr/model", "@/connfail/model", "@/empty/model", "@/success/model"],
    baseOpts({
      exec: makeExec({
        servererr: up.base,
        connfail: `http://127.0.0.1:${dead}`,
        empty: up.base,
        success: up.base,
      }),
    }),
  );
  up.stop();

  expect(result.status).toBe(200);
  expect(result.engineUsed).toBe("success");
});

test("a stream that dies after the first byte does not advance, and the failure lands in provenance", async () => {
  const flaky = startFlakyStreamUpstream();
  const up = startFakeUpstream({ unused: { status: 200, body: "should never be seen" } });
  const { lines, write } = collectLines();

  const result = await runChain(
    ["@/flaky/model", "@/unused/model"],
    baseOpts({ exec: makeExec({ flaky: flaky.base, unused: up.base }), write }),
  );
  flaky.stop();

  expect(result.stream).toBeDefined();
  const reader = (result.stream as ReadableStream).getReader();
  let sawError = false;
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }
  } catch {
    sawError = true;
  }
  up.stop();

  expect(sawError).toBe(true);
  expect(up.requestLog).not.toContain("unused");
  const record = JSON.parse(lines[0] ?? "");
  expect(record.attempts).toHaveLength(1);
  expect(record.attempts[0].ok).toBe(false);
  expect(record.attempts[0].failure).toBeDefined();
});

test("every hop failing returns 503 listing each attempt", async () => {
  const up = startFakeUpstream({
    servererr: { status: 500, body: "boom", contentType: "text/plain" },
  });
  const dead = deadPort();

  const result = await runChain(
    ["@/servererr/model", "@/connfail/model"],
    baseOpts({ exec: makeExec({ servererr: up.base, connfail: `http://127.0.0.1:${dead}` }) }),
  );
  up.stop();

  expect(result.status).toBe(503);
  const body = result.body as { attempts: unknown[] };
  expect(body.attempts).toHaveLength(2);
});

test("local_only truncates after the last local hop: later remote hops are never invoked", async () => {
  const up = startFakeUpstream({
    localengine: { status: 200, body: "local answer", contentType: "text/plain" },
    remote1: { status: 200, body: "should never be seen" },
    remote2: { status: 200, body: "should never be seen" },
  });
  const egress: Record<string, Egress> = {
    localengine: "none",
    remote1: "remote",
    remote2: "remote",
  };

  const result = await runChain(
    ["@/localengine/model", "@/remote1/model", "@/remote2/model"],
    baseOpts({
      localOnly: true,
      egressOf: (engine) => egress[engine] ?? "remote",
      exec: makeExec({ localengine: up.base, remote1: up.base, remote2: up.base }),
    }),
  );
  up.stop();

  expect(result.status).toBe(200);
  expect(result.engineUsed).toBe("localengine");
  expect(up.requestLog).not.toContain("remote1");
  expect(up.requestLog).not.toContain("remote2");
});

test("a chain with no local hop and local_only true returns 400 without calling exec", async () => {
  const result = await runChain(
    ["@/remote1/model", "@/remote2/model"],
    baseOpts({
      localOnly: true,
      egressOf: () => "remote",
      exec: () => {
        throw new Error("exec must not be called when local_only has no local hop");
      },
    }),
  );

  expect(result.status).toBe(400);
});

test("the per-attempt timeout is per hop, not per request: two hops each under the bound both run", async () => {
  const HOP_DELAY_MS = 100;
  const PER_HOP_TIMEOUT_MS = 400;
  const up = startFakeUpstream({
    slowFail: { status: 500, body: "boom", contentType: "text/plain", delayMs: HOP_DELAY_MS },
    slowSuccess: { status: 200, body: "answer", contentType: "text/plain", delayMs: HOP_DELAY_MS },
  });

  const result = await runChain(
    ["@/slowFail/model", "@/slowSuccess/model"],
    baseOpts({
      timeoutMs: PER_HOP_TIMEOUT_MS,
      exec: makeExec({ slowFail: up.base, slowSuccess: up.base }),
    }),
  );
  up.stop();

  expect(result.status).toBe(200);
  expect(result.engineUsed).toBe("slowSuccess");
});
