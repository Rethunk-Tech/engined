import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import process from "node:process";
import { bindDualFamily } from "../../src/main.ts";

/**
 * `bindDualFamily` is exported specifically so a test binds through the
 * real listener setup rather than a hand-rolled `Bun.serve` pair that would
 * pass even if the `::1` listener were deleted from it. Everything else in
 * this repo's test suite exercises the door's `fetch` function in-process
 * (a direct call, no socket); nothing before this file opened a real TCP
 * connection to prove both loopback families actually answer.
 *
 * Binds port 0 (OS-assigned) rather than the real 29200 -- this must never
 * collide with the actually-running engined unit.
 *
 * The bind lives in `beforeAll`, not the `describe` body: bun still calls a
 * skipped describe's own body to enumerate its tests (confirmed empirically
 * -- only `beforeAll`/`afterAll`/`test` bodies are actually skipped), so a
 * real socket opened directly in the body would bind on every `bun test`
 * run, ENGINED_LOCAL or not, and never get closed.
 */
const MARKER = "engined-network-local-smoke";

describe.skipIf(process.env.ENGINED_LOCAL !== "1")("dual-family real socket (local)", () => {
  let bound: ReturnType<typeof bindDualFamily> | undefined;

  beforeAll(() => {
    bound = bindDualFamily(() => new Response(MARKER), 0);
  });

  afterAll(() => {
    bound?.v4.stop(true);
    bound?.v6.stop(true);
  });

  test("127.0.0.1 and [::1] both answer on the same real port", async () => {
    if (!bound) {
      throw new Error("beforeAll did not run -- bound is unset");
    }
    const { port } = bound.v4;
    expect(bound.v6.port).toBe(port);

    const v4 = await fetch(`http://127.0.0.1:${port}/`);
    const v6 = await fetch(`http://[::1]:${port}/`);

    expect(v4.status).toBe(200);
    expect(await v4.text()).toBe(MARKER);
    expect(v6.status).toBe(200);
    expect(await v6.text()).toBe(MARKER);
  });
});

/**
 * A cold start -- container plus a multi-gigabyte GGUF -- routinely outruns
 * Bun's default 10s socket timer, which closes the connection with no body
 * at all. That is why this needs a real socket: the in-process `fetch` call
 * every other test makes never opens one, so it cannot observe the timer.
 */
describe.skipIf(process.env.ENGINED_LOCAL !== "1")(
  "slow response over a real socket (local)",
  () => {
    const SLOWER_THAN_BUN_DEFAULT_MS = 12_000;
    let bound: ReturnType<typeof bindDualFamily> | undefined;

    beforeAll(() => {
      bound = bindDualFamily(async () => {
        await new Promise((resolve) => setTimeout(resolve, SLOWER_THAN_BUN_DEFAULT_MS));
        return new Response(MARKER);
      }, 0);
    });

    afterAll(() => {
      bound?.v4.stop(true);
      bound?.v6.stop(true);
    });

    test("an answer slower than Bun's default idle timeout still reaches the caller", async () => {
      if (!bound) {
        throw new Error("beforeAll did not run -- bound is unset");
      }
      const res = await fetch(`http://127.0.0.1:${bound.v4.port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(MARKER);
    }, 60_000);
  },
);
