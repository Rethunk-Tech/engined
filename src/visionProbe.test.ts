import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runVisionProbe, splitColorPng, visionVerdict } from "./visionProbe.ts";

/** The ExecStart flag, read once: a regex rebuilt per call is a lint warning and a wasted compile. */
const RX_EXEC_START_FLAG = /^ExecStart=.*?(--[a-z-]+)\s*$/m;

/** A door whose model menu is `rows` and whose chat verb always answers `reply`. */
function fakeDoor(rows: unknown[], reply: string, menuStatus = 200): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/openai/v1/models")) {
      return Promise.resolve(
        new Response(JSON.stringify({ object: "list", data: rows }), { status: menuStatus }),
      );
    }
    return Promise.resolve(Response.json({ choices: [{ message: { content: reply } }] }));
  }) as typeof fetch;
}

const VISION_ROW = { id: "@/llama/see", role: "vision", state: "installed" };

test("the probe sends a real PNG: signature, and IHDR carrying the size it was asked for", () => {
  const png = splitColorPng(64, [220, 20, 20], [20, 20, 220]);
  expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  // IHDR's width and height sit at bytes 16 and 20: 8 signature + 4 length +
  // 4 type. A PNG whose header disagreed with its pixel data would decode to
  // nothing and the whole probe would be testing a decode failure.
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(view.getUint32(16)).toBe(64);
  expect(view.getUint32(20)).toBe(64);
  expect(new TextDecoder().decode(png.slice(12, 16))).toBe("IHDR");
});

test("the verdict needs both halves and their order, not one colour", () => {
  expect(visionVerdict("Red, blue.").ok).toBe(true);
  // The defect this exists to catch names plausible colours; naming them
  // backwards is the part guessing cannot get right.
  expect(visionVerdict("Blue, red.").ok).toBe(false);
  expect(visionVerdict("Blue.").ok).toBe(false);
  expect(visionVerdict("A photograph of a cat.").ok).toBe(false);
  // The detail carries the reply, because a failure nobody can read is a
  // failure nobody acts on.
  expect(visionVerdict("Blue, red.").detail).toContain("Blue, red.");
});

test("a vision address that answers correctly proves", async () => {
  const report = await runVisionProbe("http://door", fakeDoor([VISION_ROW], "red then blue"));
  expect(report.ok).toBe(true);
  expect(report.lines).toEqual([{ address: "@/llama/see", ok: true, detail: '"red then blue"' }]);
});

test("a vision address that names the halves backwards fails, and the line says which address", async () => {
  const report = await runVisionProbe("http://door", fakeDoor([VISION_ROW], "blue then red"));
  expect(report.ok).toBe(false);
  expect(report.lines[0]?.address).toBe("@/llama/see");
  expect(report.lines[0]?.detail).toContain("wrong order");
});

test("only vision rows are probed: a chat row serves the same path and is left alone", async () => {
  const rows = [
    { id: "@/llama/ornith", role: "chat", state: "installed" },
    { id: "@/llama/embed", role: "embedding", state: "installed" },
  ];
  // Every row would fail the verdict if it were sent, so a pass here is proof
  // none of them was.
  const report = await runVisionProbe("http://door", fakeDoor(rows, "a cat"));
  expect(report.ok).toBe(true);
  expect(report.lines[0]?.detail).toBe("no installed vision address to prove");
});

test("an unavailable vision address is not probed: /engined/v1/engines already names its fix", async () => {
  const rows = [{ id: "@/llama/see", role: "vision", state: "unavailable" }];
  const report = await runVisionProbe("http://door", fakeDoor(rows, "a cat"));
  expect(report.ok).toBe(true);
  expect(report.lines[0]?.detail).toBe("no installed vision address to prove");
});

// Measured against the live install before the daemon was updated: a door
// built before `role` answers with every vision route present and no role on
// any of them, and reading only "is any row vision?" reports a pass it never
// earned. The failure names the install command because that is the fix.
test("a door too old to report role fails rather than reporting nothing to prove", async () => {
  const rows = [
    { id: "@/llama/ornith", state: "installed" },
    { id: "@/llama/vision", state: "installed" },
  ];
  const report = await runVisionProbe("http://door", fakeDoor(rows, "red then blue"));
  expect(report.ok).toBe(false);
  expect(report.lines[0]?.detail).toContain("install.sh");
});

test("every installed vision address is probed, not just the first", async () => {
  const rows = [VISION_ROW, { id: "@/llama/ocr", role: "vision", state: "installed" }];
  const report = await runVisionProbe("http://door", fakeDoor(rows, "blue then red"));
  expect(report.lines.map((l) => l.address)).toEqual(["@/llama/see", "@/llama/ocr"]);
  expect(report.ok).toBe(false);
});

test("a door that cannot answer for its own menu fails rather than reporting nothing to prove", async () => {
  const report = await runVisionProbe("http://door", fakeDoor([], "", 503));
  expect(report.ok).toBe(false);
  expect(report.lines[0]?.detail).toContain("503");
});

test("a door that cannot be reached at all fails", async () => {
  const dead = ((input: string | URL | Request) =>
    Promise.reject(new Error(`ECONNREFUSED ${String(input)}`))) as typeof fetch;
  const report = await runVisionProbe("http://door", dead);
  expect(report.ok).toBe(false);
  expect(report.lines[0]?.detail).toContain("ECONNREFUSED");
});

// The flag is one fact split across a unit template and an argv check, the
// same shape as RestartPreventExitStatus. Renaming it in one place leaves
// every other test green while the timer silently starts a second daemon.
test("the probe unit's ExecStart names the flag main.ts branches on", () => {
  const here = import.meta.dir;
  const unit = readFileSync(join(here, "../scripts/engined-vision-probe.service.in"), "utf8");
  const main = readFileSync(join(here, "main.ts"), "utf8");
  const flag = unit.match(RX_EXEC_START_FLAG)?.[1];
  expect(flag).toBe("--vision-probe");
  expect(main).toContain(`process.argv.includes("${flag}")`);
});
