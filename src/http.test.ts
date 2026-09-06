import { expect, test } from "bun:test";
import { discardBody } from "./http.ts";

/**
 * A response whose body records whether anything ever cancelled it, standing in
 * for an engine that is still producing when the door gives up on the reply.
 */
function watchedResponse(): { res: Response; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { res: new Response(body, { status: 502 }), cancelled: () => cancelled };
}

test("a body the door will not read is cancelled rather than left to a collector", async () => {
  const { res, cancelled } = watchedResponse();

  await discardBody(res);

  expect(cancelled()).toBe(true);
});

/**
 * The counterfactual the helper exists for: dropping the reference does not
 * reach the producer, so an engine answering an error keeps its side open.
 */
test("dropping the reference instead never reaches the producer", async () => {
  // The reference is dropped by never binding it, which is the case under
  // test -- a `void res` would have kept one alive to satisfy the linter.
  const { cancelled } = watchedResponse();

  await Bun.sleep(1);

  expect(cancelled()).toBe(false);
});

test("a body already released is not an error the caller has to handle", async () => {
  const { res } = watchedResponse();
  await res.body?.cancel();

  await discardBody(res);
});

test("a response carrying no body at all is a no-op", async () => {
  await discardBody(new Response(null, { status: 204 }));
});
