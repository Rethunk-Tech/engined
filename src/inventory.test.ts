import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Exec as SecretExec } from "./exec.ts";
import { decodeAddressSegment, encodeAddressSegment, Inventory } from "./inventory.ts";
import { makeTestRoot, startFakeUpstream, upstream } from "./test-support.ts";
import type { Upstream } from "./types.ts";
import { MS_PER_SECOND } from "./types.ts";

const TEST_ROOT = makeTestRoot("engined-inventory-test-");
const SECRET_VALUE = "sk-not-a-real-key";
const foundSecret: SecretExec = async () => ({
  stdout: `${SECRET_VALUE}\n`,
  stderr: "",
  exitCode: 0,
});

const SECRET_REF = {
  service: "svc",
  username: "user",
  header: "authorization",
  scheme: "Bearer",
} as const;

describe("address segment encoding", () => {
  test("only a slash becomes %2F, and the reverse restores the provider id", () => {
    expect(encodeAddressSegment("org/model:free")).toBe("org%2Fmodel:free");
    expect(decodeAddressSegment("org%2Fmodel:free")).toBe("org/model:free");
    expect(encodeAddressSegment("plain")).toBe("plain");
    expect(decodeAddressSegment("plain")).toBe("plain");
    expect(encodeAddressSegment("a/b/c")).toBe("a%2Fb%2Fc");
  });

  test("a provider id that already contains %2F, or the wildcard sentinel, is skipped", () => {
    expect(encodeAddressSegment("org%2Fmodel")).toBeUndefined();
    expect(encodeAddressSegment("*")).toBeUndefined();
  });
});

function catalogUpstream(base: string, maxAge = 86_400): Upstream {
  return upstream({
    id: "openrouter",
    base_url: base,
    secret: { ...SECRET_REF },
    egress: "remote",
    inventory_max_age_seconds: maxAge,
  });
}

function modelsList(ids: string[]): Response {
  return Response.json({
    object: "list",
    data: ids.map((id) => ({ id, object: "model" })),
  });
}

describe("provider /models inventory", () => {
  test("a fake catalog listing org/model:free is cached as that wire id", async () => {
    const headers: string[] = [];
    const fake = startFakeUpstream((req) => {
      headers.push(req.headers.get("authorization") ?? "");
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/models") {
        return modelsList(["org/model:free", "plain", "*", "already%2Fencoded"]);
      }
      return new Response("not found", { status: 404 });
    });
    const stateRoot = join(TEST_ROOT, "state-ok");
    const inv = new Inventory({ secretExec: foundSecret, stateRoot });
    try {
      const result = await inv.refresh(catalogUpstream(fake.base));
      expect(result.ids).toEqual(["org/model:free", "plain"]);
      expect(result.fetchError).toBeUndefined();
      expect(headers).toEqual([`Bearer ${SECRET_VALUE}`]);
      expect(inv.peek(catalogUpstream(fake.base))).toEqual(["org/model:free", "plain"]);
      const onDisk = JSON.parse(
        readFileSync(join(stateRoot, "upstreams", "openrouter", "inventory.json"), "utf8"),
      ) as { ids: string[]; fetched_at: number };
      expect(onDisk.ids).toEqual(["org/model:free", "plain"]);
      expect(JSON.stringify(onDisk)).not.toContain(SECRET_VALUE);
    } finally {
      fake.stop();
    }
  });

  test("before any successful fetch, peek is empty", () => {
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot: join(TEST_ROOT, "state-empty"),
    });
    expect(inv.peek(catalogUpstream("http://127.0.0.1:1"))).toEqual([]);
  });

  test("an empty catalog persists as no ids", async () => {
    const fake = startFakeUpstream((req) => {
      if (req.method === "GET" && new URL(req.url).pathname === "/models") {
        return modelsList([]);
      }
      return new Response("not found", { status: 404 });
    });
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot: join(TEST_ROOT, "state-empty-list"),
    });
    try {
      expect((await inv.refresh(catalogUpstream(fake.base))).ids).toEqual([]);
      expect(inv.peek(catalogUpstream(fake.base))).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("a failed live fetch serves an in-age cache and names the error", async () => {
    let fail = false;
    const fake = startFakeUpstream((req) => {
      if (fail) {
        return new Response("nope", { status: 502 });
      }
      if (req.method === "GET" && new URL(req.url).pathname === "/models") {
        return modelsList(["org/model:free"]);
      }
      return new Response("not found", { status: 404 });
    });
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot: join(TEST_ROOT, "state-stale-ok"),
    });
    const u = catalogUpstream(fake.base);
    try {
      await inv.refresh(u);
      fail = true;
      const result = await inv.refresh(u);
      expect(result.ids).toEqual(["org/model:free"]);
      expect(result.fetchError).toMatch(/HTTP 502/);
    } finally {
      fake.stop();
    }
  });

  test("an expired cache is dropped and expands empty", () => {
    const stateRoot = join(TEST_ROOT, "state-expired");
    const cacheDir = join(stateRoot, "upstreams", "openrouter");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "inventory.json"),
      `${JSON.stringify({ fetched_at: 1, ids: ["org/model:free"] })}\n`,
    );
    const now = 10 * MS_PER_SECOND;
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot,
      now: () => now,
    });
    const u = catalogUpstream("http://127.0.0.1:1", 5);
    expect(inv.peek(u)).toEqual([]);
    expect(existsSync(join(cacheDir, "inventory.json"))).toBe(false);
  });

  test("a failed fetch with an expired cache expands empty", async () => {
    const stateRoot = join(TEST_ROOT, "state-expired-fetch");
    const cacheDir = join(stateRoot, "upstreams", "openrouter");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "inventory.json"),
      `${JSON.stringify({ fetched_at: 1, ids: ["org/model:free"] })}\n`,
    );
    const fake = startFakeUpstream(() => new Response("nope", { status: 503 }));
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot,
      now: () => 10 * MS_PER_SECOND,
    });
    try {
      const result = await inv.refresh(catalogUpstream(fake.base, 5));
      expect(result.ids).toEqual([]);
      expect(result.fetchError).toMatch(/HTTP 503/);
      expect(existsSync(join(cacheDir, "inventory.json"))).toBe(false);
    } finally {
      fake.stop();
    }
  });

  test("an injected fetch is used instead of the network", async () => {
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot: join(TEST_ROOT, "state-inject"),
      fetch: async () => modelsList(["org/model:free"]),
    });
    const result = await inv.refresh(catalogUpstream("https://example.invalid"));
    expect(result.ids).toEqual(["org/model:free"]);
  });
});
