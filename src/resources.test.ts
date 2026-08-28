import { expect, test } from "bun:test";
import { parseGraphicsBytes, parseResources } from "./resources.ts";

const GIB = 1024 ** 3;

// Captured verbatim from `engined-local-llama` with two models resident.
// Note the padding the kernel puts after `drm-memory-gtt` -- an exact-match
// key comparison without a trim silently drops the larger of the two numbers.
const TWO_MODELS = `19310452736
dri
/proc/101/fdinfo/5:drm-client-id:\t14919
/proc/101/fdinfo/5:drm-memory-vram:\t41440 KiB
/proc/101/fdinfo/5:drm-memory-gtt: \t28363444 KiB
/proc/186/fdinfo/5:drm-client-id:\t15002
/proc/186/fdinfo/5:drm-memory-vram:\t6716 KiB
/proc/186/fdinfo/5:drm-memory-gtt: \t3110280 KiB`;

test("both resident models are counted, VRAM and GTT together", () => {
  const { memory_bytes, graphics_bytes } = parseResources(TWO_MODELS);
  expect(memory_bytes).toBe(19_310_452_736);
  // (41440 + 28363444 + 6716 + 3110280) KiB, measured at 30.06 GiB on the box.
  expect(graphics_bytes).toBe(32_278_405_120);
  expect((graphics_bytes ?? 0) / GIB).toBeCloseTo(30.06, 1);
});

// One DRM client appears once per open fd, each copy repeating the client's
// whole total. The engine containers measured so far hold one fd each, so this
// changes nothing for them -- but the same read across host processes summed
// 59490 MiB where the machine held 15101 MiB, a 3.9x overcount, and nothing
// stops an engine from opening the device more than once.
test("a client holding several fds is counted once, not once per fd", () => {
  const repeated = ["dri"]
    .concat(
      [1, 2, 3, 4].map(
        (fd) =>
          `/proc/9/fdinfo/${fd}:drm-client-id:\t77\n` +
          `/proc/9/fdinfo/${fd}:drm-memory-vram:\t1024 KiB\n` +
          `/proc/9/fdinfo/${fd}:drm-memory-gtt: \t3072 KiB`,
      ),
    )
    .join("\n");
  expect(parseGraphicsBytes(repeated)).toBe(4096 * 1024);
});

// An idle container with a GPU holds nothing; one with no GPU cannot be
// measured at all. A card showing "0" for both would be lying about the second.
test("no DRM device reports null, an idle GPU reports zero", () => {
  expect(parseResources("123\nno-dri\n").graphics_bytes).toBeNull();
  expect(parseResources("123\ndri\n").graphics_bytes).toBe(0);
});

test("an unreadable cgroup reports null rather than zero bytes", () => {
  expect(parseResources("-\ndri\n").memory_bytes).toBeNull();
});
