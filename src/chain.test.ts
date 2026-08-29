import { expect, test } from "bun:test";
import { type HopExec, type RunChainOptions, runChain } from "./chain.ts";
import { collectLines, deadPort, startFakeUpstream } from "./test-support.ts";
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

/** One fake upstream shared by every hop in a test, keyed by engine id; `requestLog` is the only proof a hop was never called. */
function startBehaviorUpstream(behaviors: Record<string, Behavior>) {
  const up = startFakeUpstream(async (req) => {
    const engine = new URL(req.url).pathname.slice(1);
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
  });
  return up;
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
      return { status: res.status, stream: res.body ?? undefined };
    }
    return { status: res.status, body: await res.text() };
  };
}

function baseOpts(
  overrides: Partial<RunChainOptions> & Pick<RunChainOptions, "exec">,
): RunChainOptions {
  return {
    chain: "test-chain",
    requested: "chain-test-chain",
    localOnly: false,
    egressOf: () => "remote",
    resolveEngine: (engine) => engine,
    timeoutMs: () => DEFAULT_TIMEOUT_MS,
    // Without this every runChain here writes its provenance line to the real
    // stdout; a test that asserts on the line passes its own collector.
    write: () => undefined,
    ...overrides,
  };
}

// model_reported/model_resident and version pass-through are not covered
// here: chain.ts's HopResult -> Attempt step is an unconditional object
// spread with no branching, and the values themselves are already proven at
// llama.test.ts (the derived model_reported/model_resident computation),
// provenance.test.ts (recordCall's serialization of both fields and of
// version) and dispatch.test.ts (the door's end-to-end provenance line).

test("an alias hop's provenance records the resolved engine id, not the raw alias", async () => {
  const { lines, write } = collectLines();
  const exec: HopExec = () => Promise.resolve({ status: 200, body: "answer" });

  const result = await runChain(
    ["@/local/model"],
    baseOpts({ exec, write, resolveEngine: (engine) => (engine === "local" ? "llama" : engine) }),
  );

  expect(result.status).toBe(200);
  expect(result.engineUsed).toBe("llama");
  const record = JSON.parse(lines[0] ?? "");
  expect(record.engine_used).toBe("llama");
  expect(record.attempts[0].engine).toBe("llama");
});

test("a 4xx on hop 1 does not advance: hop 2 is never invoked", async () => {
  const up = startBehaviorUpstream({
    badreq: { status: 400, body: "bad request", contentType: "text/plain" },
    unused: { status: 200, body: "should never be seen" },
  });

  const result = await runChain(
    ["@/badreq/model", "@/unused/model"],
    baseOpts({ exec: makeExec({ badreq: up.base, unused: up.base }) }),
  );
  up.stop();

  expect(result.status).toBe(400);
  expect(up.requestLog).not.toContain("/unused");
});

test("an envelope failure on hop 1 does not advance, even carrying a 5xx status: hop 2's own call log stays empty", async () => {
  const hopCalls: string[] = [];
  const exec: HopExec = (hop) => {
    hopCalls.push(engineOf(hop));
    if (engineOf(hop) === "agentic") {
      return Promise.resolve({
        status: 502,
        body: { error: "agentic envelope failure: api_error" },
        envelopeFailure: true,
      });
    }
    return Promise.resolve({ status: 200, body: "should never be seen" });
  };

  const result = await runChain(["@/agentic/model", "@/unused/model"], baseOpts({ exec }));

  expect(result.status).toBe(502);
  expect(hopCalls).toEqual(["agentic"]);
});

test("a 5xx, a connection failure, and an empty body each advance to the next hop", async () => {
  const up = startBehaviorUpstream({
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
  const up = startBehaviorUpstream({ unused: { status: 200, body: "should never be seen" } });
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
  expect(up.requestLog).not.toContain("/unused");
  const record = JSON.parse(lines[0] ?? "");
  expect(record.attempts).toHaveLength(1);
  expect(record.attempts[0].ok).toBe(false);
  expect(record.attempts[0].failure).toBeDefined();
});

test("every hop failing returns 503 listing each attempt", async () => {
  const up = startBehaviorUpstream({
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
  const up = startBehaviorUpstream({
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
  expect(up.requestLog).not.toContain("/remote1");
  expect(up.requestLog).not.toContain("/remote2");
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
  const up = startBehaviorUpstream({
    slowFail: { status: 500, body: "boom", contentType: "text/plain", delayMs: HOP_DELAY_MS },
    slowSuccess: { status: 200, body: "answer", contentType: "text/plain", delayMs: HOP_DELAY_MS },
  });

  const result = await runChain(
    ["@/slowFail/model", "@/slowSuccess/model"],
    baseOpts({
      timeoutMs: () => PER_HOP_TIMEOUT_MS,
      exec: makeExec({ slowFail: up.base, slowSuccess: up.base }),
    }),
  );
  up.stop();

  expect(result.status).toBe(200);
  expect(result.engineUsed).toBe("slowSuccess");
});

test("a client disconnecting mid-stream still emits the call's provenance line", async () => {
  const { lines, write } = collectLines();
  const exec: HopExec = () =>
    Promise.resolve({
      status: 200,
      body: null,
      stream: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("data: chunk\n\n"));
        },
      }),
    });

  const result = await runChain(["@/e1/m"], baseOpts({ exec, write }));

  // Nothing is emitted while the body is still owed to the caller.
  expect(lines.length).toBe(0);

  const reader = result.stream?.getReader();
  await reader?.read();
  await reader?.cancel();

  expect(lines.length).toBe(1);
  const record = JSON.parse(lines[0] ?? "{}");
  expect(record.attempts[0].ok).toBe(false);
  expect(record.attempts[0].failure).toBe("client disconnected");
});
