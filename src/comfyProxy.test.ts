/**
 * `POST /engined/v1/comfy/:engine/:upstream/...`: the mediated comfy proxy.
 * Everything here treats the real container as a stand-in dependency,
 * injected the same way `llamaHttpClient`/`extrasHttpClient` already are --
 * except the websocket bridge, which needs a real socket to prove anything
 * at all, so that one test binds a real door against a real fake container.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { HttpClient } from "./http.ts";
import { bindDualFamily, createDoor } from "./main.ts";
import {
  BUNX,
  buildExec,
  config,
  deadPort,
  engine,
  makeTestRoot,
  route,
  writeEngineSpec,
} from "./test-support.ts";

const TEST_ROOT = makeTestRoot("engined-comfy-proxy-");

// `comfyDoor` points XDG_STATE_HOME at a scratch dir and leaves it there for
// the door it just built; restoring it here keeps that out of sibling suites
// sharing this process.
const PREVIOUS_STATE_HOME = process.env.XDG_STATE_HOME;
afterAll(() => {
  if (PREVIOUS_STATE_HOME === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = PREVIOUS_STATE_HOME;
  }
});

const COMFY_SPEC = `
kind = "comfy"
upstream = "self"
image = "engined/fakecomfy:local"
obtain = "build"
serves = []
command = []

[ready]
path = "/queue"
status = 200
`;

/** ComfyUI's own listen port, which its image is the one to `EXPOSE`. */
const COMFY_CONTAINER_PORT = 8188;

const PROXY_PATH = "/engined/v1/comfy/comfy/local";
/** A real ComfyUI node type: the proxy must forward the segment untouched, so the test needs one that actually exists. */
const NODE_TYPE = "KSampler";

/**
 * A running comfy engine, ready to proxy through -- `port` need not answer
 * anything real when `comfyHttpClient` intercepts every forwarded call. The
 * binding table lives under `XDG_STATE_HOME`, so each door gets a fresh one
 * unless the caller names an existing one to reopen: sharing it would let one
 * test's bindings make another test's refusal pass for the wrong reason.
 */
async function comfyDoor(comfyHttpClient?: HttpClient, port = 40_999, stateHome?: string) {
  process.env.XDG_STATE_HOME = stateHome ?? mkdtempSync(join(TEST_ROOT, "state-"));
  const root = mkdtempSync(join(TEST_ROOT, "door-"));
  writeEngineSpec(root, "comfy", COMFY_SPEC);
  const cfg = config({
    engines: [engine({ id: "comfy", models_dir: "/data/comfy", idle_stop_seconds: 9999 })],
    routes: [route({ engine: "comfy", model: undefined, upstream: "local" })],
  });
  const door = createDoor(
    cfg,
    {
      enginesRoot: root,
      bunx: BUNX,
      exec: buildExec({ port, containerPort: COMFY_CONTAINER_PORT }),
      probe: () => Promise.resolve({ status: 200 }),
    },
    { comfyHttpClient },
  );
  await door.registry.start("comfy");
  return door;
}

/** Records every call a fake comfy container's `HttpClient` receives, answering with `respond`'s own per-URL logic. */
function recordingComfyClient(
  respond: (url: string, init?: RequestInit) => Promise<Response> | Response,
): { client: HttpClient; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client: HttpClient = async (url, init) => {
    calls.push({ url, init });
    return await respond(url, init);
  };
  return { client, calls };
}

describe("comfy proxy: forwarded as-is", () => {
  test("GET object_info/{nodeType} is forwarded verbatim", async () => {
    const { client, calls } = recordingComfyClient(() =>
      Response.json({
        [NODE_TYPE]: { input: { required: { seed: [["INT"]] } } },
      }),
    );
    const door = await comfyDoor(client);
    const res = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/object_info/${NODE_TYPE}`),
    );
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toContain(`/object_info/${NODE_TYPE}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body[NODE_TYPE]).toBeDefined();
  });

  test("GET system_stats is forwarded verbatim", async () => {
    const { client, calls } = recordingComfyClient(() =>
      Response.json({ system: { os: "posix" } }),
    );
    const door = await comfyDoor(client);
    const res = await door.fetch(new Request(`http://engined${PROXY_PATH}/system_stats`));
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toContain("/system_stats");
  });
});

describe("comfy proxy: POST /prompt binds the result, POST /upload/image namespaces it", () => {
  test("a submitted prompt's id becomes known to this door, and nothing else", async () => {
    const { client } = recordingComfyClient(() => Response.json({ prompt_id: "job-1", number: 1 }));
    const door = await comfyDoor(client);
    const res = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: {}, client_id: "whatever" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { prompt_id: string }).prompt_id).toBe("job-1");
  });

  test("an uploaded filename reaches comfy renamed, never the caller's literal name", async () => {
    const { client, calls } = recordingComfyClient(async (_url, init) => {
      const form = await (init?.body as FormData);
      const image = form.get("image") as File;
      return Response.json({ name: image.name, subfolder: "", type: "input" });
    });
    const door = await comfyDoor(client);
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array([1, 2, 3])]), "reference.png");
    const res = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/upload/image`, { method: "POST", body: form }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).not.toBe("reference.png");
    expect(body.name.endsWith("reference.png")).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("comfy proxy: GET /view is mediated", () => {
  test("a filename no completed job produced is refused byte-identically, whether or not it exists on disk", async () => {
    const { client, calls } = recordingComfyClient(() => new Response("should never be reached"));
    const door = await comfyDoor(client);
    const neverKnown = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=nothing-like-this-exists.png`),
    );
    const alsoNeverKnown = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=some-other-name.png`),
    );
    expect(neverKnown.status).toBe(alsoNeverKnown.status);
    expect(await neverKnown.text()).toBe(await alsoNeverKnown.text());
    // Refused before ever reaching comfy -- the mediation checks this door's
    // own known-filenames set, never the container's disk.
    expect(calls).toHaveLength(0);
  });

  test("a filename a completed history read actually surfaced is served", async () => {
    const { client } = recordingComfyClient((url) => {
      if (url.includes("/prompt")) {
        return Response.json({ prompt_id: "job-2" });
      }
      if (url.includes("/history/")) {
        return Response.json({
          "job-2": {
            outputs: { "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
          },
        });
      }
      if (url.includes("/view")) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const door = await comfyDoor(client);

    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: "POST", body: "{}" }),
    );
    await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-2`));
    const viewed = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=out.png&subfolder=&type=output`),
    );

    expect(viewed.status).toBe(200);
    expect(viewed.headers.get("content-type")).toBe("image/png");
  });
});

// `outputs` is comfy's node-id table. Anything else -- an array of node outputs
// included -- names no filename, so `/view` never reaches the container for one
// a caller read out of a malformed history entry.
describe("comfy proxy: a history entry only binds what its node table names", () => {
  test("an outputs that is not a node table binds no filename", async () => {
    const { client, calls } = recordingComfyClient((url) => {
      if (url.includes("/prompt")) {
        return Response.json({ prompt_id: "job-o" });
      }
      if (url.includes("/history/")) {
        return Response.json({ "job-o": { outputs: [{ images: [{ filename: "out.png" }] }] } });
      }
      return new Response("should never be reached");
    });
    const door = await comfyDoor(client);

    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: "POST", body: "{}" }),
    );
    await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-o`));
    const viewed = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=out.png`),
    );

    expect(viewed.status).toBe(404);
    expect(calls.filter((c) => c.url.includes("/view"))).toHaveLength(0);
  });
});

describe("comfy proxy: GET /history is never served bare or for an unknown prompt_id", () => {
  test("an unknown prompt_id is refused without reaching comfy", async () => {
    const { client, calls } = recordingComfyClient(() => new Response("should never be reached"));
    const door = await comfyDoor(client);
    const res = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/history/never-submitted`),
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("comfy proxy: a filename belongs to the prompt that produced it", () => {
  /**
   * `/history` seeds filenames under the ONE prompt it read, never an
   * engine-wide set: an id the caller does own must not turn another
   * prompt's output into a servable filename.
   */
  test("a filename surfaced under prompt A is not viewable by way of prompt B", async () => {
    const { client } = recordingComfyClient((url) => {
      if (url.includes("/prompt")) {
        return Response.json({ prompt_id: "job-a" });
      }
      if (url.includes("/history/job-a")) {
        return Response.json({
          "job-a": { outputs: { "9": { images: [{ filename: "a.png" }] } } },
        });
      }
      if (url.includes("/history/job-b")) {
        // comfy's own answer names job-a's output; the door must not adopt it.
        return Response.json({
          "job-a": { outputs: { "9": { images: [{ filename: "secret.png" }] } } },
        });
      }
      return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
    });
    const door = await comfyDoor(client);

    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: "POST", body: "{}" }),
    );
    await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-a`));
    await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-b`));

    const own = await door.fetch(new Request(`http://engined${PROXY_PATH}/view?filename=a.png`));
    const other = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=secret.png`),
    );

    expect(own.status).toBe(200);
    expect(other.status).toBe(404);
  });
});

describe("comfy proxy: the binding table outlives the process", () => {
  /** A restart that forgot its bindings would refuse a stored output to the caller that created it. */
  test("a filename bound before a restart is still served after one", async () => {
    const stateHome = mkdtempSync(join(TEST_ROOT, "state-restart-"));
    const respond = (url: string): Response => {
      if (url.includes("/prompt")) {
        return Response.json({ prompt_id: "job-r" });
      }
      if (url.includes("/history/")) {
        return Response.json({
          "job-r": { outputs: { "9": { images: [{ filename: "kept.png" }] } } },
        });
      }
      return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
    };

    const before = await comfyDoor(recordingComfyClient(respond).client, 40_999, stateHome);
    await before.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: "POST", body: "{}" }),
    );
    await before.fetch(new Request(`http://engined${PROXY_PATH}/history/job-r`));

    const after = await comfyDoor(recordingComfyClient(respond).client, 40_999, stateHome);
    const viewed = await after.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=kept.png`),
    );
    const unbound = await after.fetch(
      new Request(`http://engined${PROXY_PATH}/view?filename=never.png`),
    );

    expect(viewed.status).toBe(200);
    expect(unbound.status).toBe(404);
  });
});

describe("comfy proxy: control verbs never forwarded", () => {
  test("GET /queue bare, POST /free and POST /interrupt all 404 -- release is the only way to drop weights", async () => {
    const { client, calls } = recordingComfyClient(() => new Response("should never be reached"));
    const door = await comfyDoor(client);

    const bareQueue = await door.fetch(new Request(`http://engined${PROXY_PATH}/queue`));
    const free = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/free`, { method: "POST" }),
    );
    const interrupt = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/interrupt`, { method: "POST" }),
    );

    expect(bareQueue.status).toBe(404);
    expect(free.status).toBe(404);
    expect(interrupt.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("POST /queue delete is refused for a prompt_id this door never bound, and forwarded for one it did", async () => {
    const { client, calls } = recordingComfyClient((url) => {
      if (url.includes("/prompt")) {
        return Response.json({ prompt_id: "job-3" });
      }
      return Response.json({});
    });
    const door = await comfyDoor(client);
    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: "POST", body: "{}" }),
    );

    const foreign = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/queue`, {
        method: "POST",
        body: JSON.stringify({ delete: ["someone-elses-job"] }),
      }),
    );
    expect(foreign.status).toBe(404);
    expect(calls.filter((c) => c.url.includes("/queue"))).toHaveLength(0);

    const own = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/queue`, {
        method: "POST",
        body: JSON.stringify({ delete: ["job-3"] }),
      }),
    );
    expect(own.status).toBe(200);
    expect(calls.filter((c) => c.url.includes("/queue"))).toHaveLength(1);
  });
});

/** A minimal stand-in for ComfyUI's own `/ws?clientId=` endpoint: records every clientId a connection dialed in with, and lets the test push frames back down whichever socket is currently open. */
function fakeComfyWsContainer(): {
  port: number;
  stop: () => void;
  connectedClientIds: string[];
  sendText: (data: unknown) => void;
  sendBinary: (bytes: Uint8Array) => void;
} {
  const connectedClientIds: string[] = [];
  let current: import("bun").ServerWebSocket<{ clientId: string }> | undefined;
  const server = Bun.serve<{ clientId: string }>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const clientId = url.searchParams.get("clientId") ?? "";
        const upgraded = srv.upgrade(req, { data: { clientId } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        connectedClientIds.push(ws.data.clientId);
        current = ws;
      },
      message() {
        // Frames only flow comfy -> caller in this suite; nothing the caller sends is asserted on.
      },
      close() {
        current = undefined;
      },
    },
  });
  return {
    port: server.port ?? 0,
    stop: () => server.stop(true),
    connectedClientIds,
    sendText: (data) => current?.send(JSON.stringify(data)),
    sendBinary: (bytes) => current?.send(bytes),
  };
}

/** A running comfy engine behind a door bound on a REAL socket -- the one thing a websocket upgrade needs. */
async function startWsDoor(): Promise<{
  fakeComfy: ReturnType<typeof fakeComfyWsContainer>;
  doorPort: number;
  stop: () => void;
}> {
  const fakeComfy = fakeComfyWsContainer();
  const root = mkdtempSync(join(TEST_ROOT, "door-ws-"));
  writeEngineSpec(root, "comfy", COMFY_SPEC);
  const doorPort = deadPort();
  // `checkOrigin` refuses any `Host` outside `config.listen_port`, so the
  // config must agree with the port the door is actually bound on.
  const cfg = config({
    listen_port: doorPort,
    engines: [engine({ id: "comfy", models_dir: "/data/comfy", idle_stop_seconds: 9999 })],
    routes: [route({ engine: "comfy", model: undefined, upstream: "local" })],
  });
  const door = createDoor(cfg, {
    enginesRoot: root,
    bunx: BUNX,
    exec: buildExec({ port: fakeComfy.port, containerPort: COMFY_CONTAINER_PORT }),
    probe: () => Promise.resolve({ status: 200 }),
  });
  await door.registry.start("comfy");
  const bound = bindDualFamily(door.fetch, doorPort);
  return {
    fakeComfy,
    doorPort,
    stop: () => {
      bound.v4.stop(true);
      bound.v6.stop(true);
      fakeComfy.stop();
    },
  };
}

/** Resolves with the first frame `pick` accepts, then stops listening. */
function nextFrame<T>(caller: WebSocket, pick: (data: unknown) => T | undefined): Promise<T> {
  return new Promise<T>((resolve) => {
    const onMsg = (ev: MessageEvent) => {
      const picked = pick(ev.data);
      if (picked !== undefined) {
        caller.removeEventListener("message", onMsg);
        resolve(picked);
      }
    };
    caller.addEventListener("message", onMsg);
  });
}

function pickTextFrame(data: unknown): string | undefined {
  return typeof data === "string" ? data : undefined;
}

function pickBinaryFrame(data: unknown): ArrayBuffer | undefined {
  return data instanceof ArrayBuffer ? data : undefined;
}

function openCaller(caller: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    caller.onopen = () => resolve();
    caller.onerror = () => reject(new Error("caller socket failed to open"));
  });
}

describe("comfy proxy: the websocket bridge", () => {
  test("the door assigns its own clientId, announces it first, and bridges text and binary frames", async () => {
    const { fakeComfy, doorPort, stop } = await startWsDoor();
    try {
      const caller = new WebSocket(
        `ws://127.0.0.1:${doorPort}${PROXY_PATH}/ws?clientId=caller-picked-this`,
      );
      caller.binaryType = "arraybuffer";
      // Listen before the socket opens: the announcement is the first frame down.
      const firstFrame = nextFrame(caller, pickTextFrame);
      await openCaller(caller);

      const announced = JSON.parse(await firstFrame) as {
        type: string;
        data: { client_id: string };
      };
      expect(announced.type).toBe("client_id");
      // The door minted its own id -- never the one the caller asked for in
      // the query string, which is exactly the eavesdrop this exists to close.
      expect(announced.data.client_id).not.toBe("caller-picked-this");
      // ...and it is the SAME id the door itself dialed comfy's real /ws with.
      expect(fakeComfy.connectedClientIds).toEqual([announced.data.client_id]);

      const progressText = nextFrame(caller, pickTextFrame);
      fakeComfy.sendText({ type: "progress", data: { value: 3, max: 10 } });
      expect(JSON.parse(await progressText)).toEqual({
        type: "progress",
        data: { value: 3, max: 10 },
      });

      const binaryFrame = nextFrame(caller, pickBinaryFrame);
      const preview = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9]);
      fakeComfy.sendBinary(preview);
      expect(new Uint8Array(await binaryFrame)).toEqual(preview);

      caller.close();
    } finally {
      stop();
    }
  });
});

type Door = Awaited<ReturnType<typeof comfyDoor>>;

function cancellingComfyClient(
  running: string[],
  pending: string[],
  deleteStatus = 200,
  interruptStatus = 200,
) {
  return recordingComfyClient((url, init) => {
    if (url.includes("/prompt")) {
      return Response.json({ prompt_id: "job-c" });
    }
    if (url.includes("/interrupt")) {
      return Response.json({}, { status: interruptStatus });
    }
    if (url.includes("/queue") && init?.method !== "POST") {
      return Response.json({
        queue_running: running.map((id) => [0, id]),
        queue_pending: pending.map((id) => [0, id]),
      });
    }
    return Response.json({}, { status: deleteStatus });
  });
}

async function boundDoor(client: HttpClient) {
  const door = await comfyDoor(client);
  await door.fetch(
    new Request(`http://engined${PROXY_PATH}/prompt`, { method: "POST", body: "{}" }),
  );
  return door;
}

function cancel(door: Door, promptId: string) {
  return door.fetch(
    new Request(`http://engined${PROXY_PATH}/cancel`, {
      method: "POST",
      body: JSON.stringify({ prompt_id: promptId }),
    }),
  );
}

// The door refuses a bare `/interrupt` because comfy carries no id to scope
// it. `/cancel` is what makes one safe: the door reads the queue itself and
// only interrupts once the running prompt is provably the caller's own.
describe("comfy proxy: a scoped cancel the door can prove and perform", () => {
  test("POST /cancel interrupts the container only when the caller's own prompt is the running one", async () => {
    const { client, calls } = cancellingComfyClient(["job-c"], []);
    const res = await cancel(await boundDoor(client), "job-c");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prompt_id: "job-c", cancelled: "running" });
    expect(calls.filter((c) => c.url.includes("/interrupt"))).toHaveLength(1);
  });

  test("POST /cancel drops a not-yet-started prompt from the queue instead of interrupting", async () => {
    const { client, calls } = cancellingComfyClient(["someone-elses-job"], ["job-c"]);
    const res = await cancel(await boundDoor(client), "job-c");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prompt_id: "job-c", cancelled: "pending" });
    expect(calls.filter((c) => c.url.includes("/interrupt"))).toHaveLength(0);
    const deletes = calls.filter((c) => c.url.includes("/queue") && c.init?.method === "POST");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.init?.body).toBe(JSON.stringify({ delete: ["job-c"] }));
  });

  // A cancel that lands after the render finished must not interrupt whatever
  // inherited the GPU behind it.
  test("POST /cancel reports a finished prompt without touching the container", async () => {
    const { client, calls } = cancellingComfyClient(["a-later-job"], []);
    const res = await cancel(await boundDoor(client), "job-c");

    expect(await res.json()).toEqual({ prompt_id: "job-c", cancelled: "finished" });
    expect(calls.filter((c) => c.url.includes("/interrupt"))).toHaveLength(0);
  });
});

describe("comfy proxy: a scoped cancel the door refuses", () => {
  // Reporting a cancel comfy never performed is worse than reporting none:
  // the caller stops waiting for a prompt that is still queued to render.
  test("POST /cancel reports a queue delete comfy refused, never a cancel it did not perform", async () => {
    const { client } = cancellingComfyClient(["someone-elses-job"], ["job-c"], 500);
    const res = await cancel(await boundDoor(client), "job-c");
    const body = (await res.json()) as { error?: string; cancelled?: string };

    expect(res.status).toBe(502);
    expect(body.cancelled).toBeUndefined();
    expect(body.error).toContain("http 500");
  });

  // The running branch is the one holding the GPU: a caller told the render was
  // interrupted stops polling, and a refused interrupt leaves it rendering to
  // completion with nobody waiting on it.
  test("POST /cancel reports an interrupt comfy refused, never a cancel it did not perform", async () => {
    const { client, calls } = cancellingComfyClient(["job-c"], [], 200, 500);
    const res = await cancel(await boundDoor(client), "job-c");
    const body = (await res.json()) as { error?: string; cancelled?: string };

    expect(res.status).toBe(502);
    expect(body.cancelled).toBeUndefined();
    expect(body.error).toContain("http 500");
    expect(calls.filter((c) => c.url.includes("/interrupt"))).toHaveLength(1);
  });

  // Whatever comfy answered, it was not a queue: the door cannot prove the
  // prompt is the caller's own, so it interrupts nothing and says so.
  test("POST /cancel refuses when comfy's queue does not read as one", async () => {
    const { client, calls } = recordingComfyClient((url) =>
      url.includes("/prompt")
        ? Response.json({ prompt_id: "job-c" })
        : new Response("null", { headers: { "content-type": "application/json" } }),
    );
    const res = await cancel(await boundDoor(client), "job-c");

    expect(res.status).toBe(502);
    expect(calls.filter((c) => c.url.includes("/interrupt"))).toHaveLength(0);
  });

  test("POST /cancel never interrupts on behalf of a prompt_id this door did not bind", async () => {
    const { client, calls } = cancellingComfyClient(["someone-elses-job"], []);
    const res = await cancel(await boundDoor(client), "someone-elses-job");

    expect(res.status).toBe(404);
    expect(calls.filter((c) => c.url.includes("/interrupt"))).toHaveLength(0);
  });
});

describe("comfy proxy: the binding table is bounded", () => {
  /**
   * The whole table is rewritten on every bind, so an unbounded one costs
   * more per prompt forever. The bound is only safe if it drops the oldest
   * binding -- evicting the newest would refuse the output of the prompt the
   * caller is still waiting on -- and if disk agrees with memory, since a
   * restart reads disk back as the whole truth.
   */
  test("past its bound the table holds 1000 and the oldest binding is the one gone, in memory and on disk", async () => {
    const stateHome = mkdtempSync(join(TEST_ROOT, "state-bound-"));
    let issued = 0;
    const respond = (url: string): Response =>
      url.includes("/prompt") ? Response.json({ prompt_id: `job-${++issued}` }) : Response.json({});

    const door = await comfyDoor(recordingComfyClient(respond).client, 40_999, stateHome);
    for (let i = 0; i < 1001; i++) {
      await door.fetch(
        new Request(`http://engined${PROXY_PATH}/prompt`, { method: "POST", body: "{}" }),
      );
    }

    const onDisk = JSON.parse(
      readFileSync(join(stateHome, "engined", "comfy-bindings.json"), "utf8"),
    ) as Record<string, string[]>;
    expect(Object.keys(onDisk)).toHaveLength(1000);

    // In memory: the first prompt bound is the one the door no longer knows,
    // and the one bound right after it survives.
    const evicted = await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-1`));
    const oldestKept = await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-2`));
    const newest = await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-1001`));
    expect(evicted.status).toBe(404);
    expect(oldestKept.status).toBe(200);
    expect(newest.status).toBe(200);

    // ...and a restart reading that file back answers identically.
    const restarted = await comfyDoor(recordingComfyClient(respond).client, 40_999, stateHome);
    expect(
      (await restarted.fetch(new Request(`http://engined${PROXY_PATH}/history/job-1`))).status,
    ).toBe(404);
    expect(
      (await restarted.fetch(new Request(`http://engined${PROXY_PATH}/history/job-2`))).status,
    ).toBe(200);
    expect(
      (await restarted.fetch(new Request(`http://engined${PROXY_PATH}/history/job-1001`))).status,
    ).toBe(200);
  });
});

describe("comfy proxy: a binding the state dir would not take", () => {
  /**
   * The table in memory is a superset of the file, never the other way
   * round: a write that fails costs the caller nothing until this process
   * restarts, where a table shrunk to match a file that never got the
   * binding would refuse an output the door itself produced.
   */
  test("a binding that could not be persisted is still served, and the file never gained it", async () => {
    const stateHome = mkdtempSync(join(TEST_ROOT, "state-readonly-"));
    const engined = join(stateHome, "engined");
    mkdirSync(engined, { mode: 0o500 });
    const { client } = recordingComfyClient((url) =>
      url.includes("/prompt") ? Response.json({ prompt_id: "job-w" }) : Response.json({}),
    );

    const door = await comfyDoor(client, 40_999, stateHome);
    const bound = await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: "POST", body: "{}" }),
    );
    const served = await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-w`));

    expect(bound.status).toBe(200);
    expect(served.status).toBe(200);
    expect(existsSync(join(engined, "comfy-bindings.json"))).toBe(false);
    chmodSync(engined, 0o700);
  });
});

describe("comfy proxy: the table is written only when it changed", () => {
  // A client watching a running prompt polls the same entry until it
  // finishes, and every one of those reads answers with what the door
  // already knows.
  test("polling /history for filenames the door already holds does not rewrite the table", async () => {
    const stateHome = mkdtempSync(join(TEST_ROOT, "state-poll-"));
    const { client } = recordingComfyClient((url) =>
      url.includes("/prompt")
        ? Response.json({ prompt_id: "job-p" })
        : Response.json({ "job-p": { outputs: { "9": { images: [{ filename: "out.png" }] } } } }),
    );

    const door = await comfyDoor(client, 40_999, stateHome);
    await door.fetch(
      new Request(`http://engined${PROXY_PATH}/prompt`, { method: "POST", body: "{}" }),
    );
    await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-p`));

    const file = join(stateHome, "engined", "comfy-bindings.json");
    rmSync(file);
    const repoll = await door.fetch(new Request(`http://engined${PROXY_PATH}/history/job-p`));

    expect(repoll.status).toBe(200);
    expect(existsSync(file)).toBe(false);
  });
});
