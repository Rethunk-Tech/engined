import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  digitsPng,
  readProbeText,
  runProbes,
  splitColorPng,
  visionReadVerdict,
  visionVerdict,
} from "./probe.ts";
import { CONTRACT } from "./types.ts";

/** The ExecStart flag, read once: a regex rebuilt per call is a lint warning and a wasted compile. */
const RX_EXEC_START_FLAG = /^ExecStart=.*?(--[a-z-]+)\s*$/m;

/** The probe's own text shape: exactly eight digits, nothing round them. */
const RX_PROBE_DIGITS = /^\d{8}$/;

/** A door whose model menu is `rows` and whose chat verb always answers `reply`. */
function fakeDoor(rows: unknown[], reply: string, menuStatus = 200): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/engined/v1/engines")) {
      return Promise.resolve(Response.json({ contract: CONTRACT, engines: [] }));
    }
    if (url.endsWith("/openai/v1/models")) {
      return Promise.resolve(
        new Response(JSON.stringify({ object: "list", data: rows }), { status: menuStatus }),
      );
    }
    return Promise.resolve(Response.json({ choices: [{ message: { content: reply } }] }));
  }) as typeof fetch;
}

const VISION_ROW = { id: "@/llama/see", role: "vision", vision: "describe", state: "installed" };

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

test("the read probe draws the digits it will check for, as a real PNG", () => {
  const png = digitsPng("40718352");
  expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // 8 glyphs of 5 cells plus a gap between each, and 2 cells of margin all
  // round, at 14 image pixels per cell.
  expect(view.getUint32(16)).toBe((8 * 6 - 1 + 4) * 14);
  expect(view.getUint32(20)).toBe((7 + 4) * 14);
  // A different string is a different image, or the probe would be sending
  // one picture and checking for another string.
  expect(Buffer.from(digitsPng("11111111")).equals(Buffer.from(png))).toBe(false);
});

test("a fresh digit string every run, so no answer comes from having seen the image", () => {
  const runs = new Set(Array.from({ length: 32 }, () => readProbeText()));
  expect([...runs].every((t) => RX_PROBE_DIGITS.test(t))).toBe(true);
  // Not a distribution test: one repeated string across 32 draws would mean a
  // constant, which is the property that matters here.
  expect(runs.size).toBeGreaterThan(1);
});

test("the read verdict wants the digits, not the wrapper a model puts round them", () => {
  expect(visionReadVerdict("40718352", "40718352").ok).toBe(true);
  // A reader that framed its answer still read the image.
  expect(visionReadVerdict("40718352", "The digits are 4071 8352.").ok).toBe(true);
  expect(visionReadVerdict("40718352", "40718353").ok).toBe(false);
  expect(visionReadVerdict("40718352", "4071835").ok).toBe(false);
  expect(visionReadVerdict("40718352", "a photograph of a cat").detail).toContain("40718352");
});

test("a read route is asked to read and a describe route to describe, from the same menu", async () => {
  const bodies: string[] = [];
  const rows = [
    VISION_ROW,
    { id: "@/llama/ocr", role: "vision", vision: "read", state: "installed" },
  ];
  const client = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/engined/v1/engines")) {
      return Promise.resolve(Response.json({ contract: CONTRACT, engines: [] }));
    }
    if (url.endsWith("/openai/v1/models")) {
      return Promise.resolve(Response.json({ object: "list", data: rows }));
    }
    bodies.push(String(init?.body ?? ""));
    // Neither check's right answer, so the assertion below is about which
    // question was asked and not about which reply happened to satisfy it.
    return Promise.resolve(Response.json({ choices: [{ message: { content: "" } }] }));
  }) as typeof fetch;

  await runProbes("http://door", client);

  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toContain("two vertical halves");
  expect(bodies[1]).toContain("Read the digits");
  expect(bodies[1]).not.toContain("two vertical halves");
});

test("a route with no vision kind gets the describe check, which is what a vision route usually is", async () => {
  const bodies: string[] = [];
  const client = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/engined/v1/engines")) {
      return Promise.resolve(Response.json({ contract: CONTRACT, engines: [] }));
    }
    if (url.endsWith("/openai/v1/models")) {
      return Promise.resolve(Response.json({ object: "list", data: [VISION_ROW] }));
    }
    bodies.push(String(init?.body ?? ""));
    return Promise.resolve(Response.json({ choices: [{ message: { content: "red blue" } }] }));
  }) as typeof fetch;

  const report = await runProbes("http://door", client);
  expect(report.ok).toBe(true);
  expect(bodies[0]).toContain("two vertical halves");
});

test("a vision address that answers correctly proves", async () => {
  const report = await runProbes("http://door", fakeDoor([VISION_ROW], "red then blue"));
  expect(report.ok).toBe(true);
  expect(report.lines).toEqual([{ address: "@/llama/see", ok: true, detail: '"red then blue"' }]);
});

test("a vision address that names the halves backwards fails, and the line says which address", async () => {
  const report = await runProbes("http://door", fakeDoor([VISION_ROW], "blue then red"));
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
  const report = await runProbes("http://door", fakeDoor(rows, "a cat"));
  expect(report.ok).toBe(true);
  expect(report.lines[0]?.detail).toBe("no reachable address to prove");
});

test("an unavailable vision address is not probed: /engined/v1/engines already names its fix", async () => {
  const rows = [{ id: "@/llama/see", role: "vision", vision: "describe", state: "unavailable" }];
  const report = await runProbes("http://door", fakeDoor(rows, "a cat"));
  expect(report.ok).toBe(true);
  expect(report.lines[0]?.detail).toBe("no reachable address to prove");
});

// Measured against the live install before the daemon was updated: a door
// built before `role` answers with every vision route present and no role on
// any of them, and reading only "is any row vision?" reports a pass it never
// earned. The failure names the install command because that is the fix.
test("a vision address with no declared kind fails rather than being guessed at", async () => {
  const rows = [{ id: "@/llama/see", role: "vision", state: "installed" }];
  const report = await runProbes("http://door", fakeDoor(rows, "red then blue"));
  expect(report.ok).toBe(false);
  expect(report.lines[0]?.detail).toContain("install.sh");
});

// Staleness is read off the door's own contract now, not guessed from
// whether any row carries a `role` -- see the contract test at the end. A
// current door whose routes simply have no roles has nothing to prove, and
// that is a pass.
test("a current door whose rows carry no role has nothing to prove, and says so", async () => {
  const rows = [
    { id: "@/llama/ornith", state: "installed" },
    { id: "@/llama/vision", state: "installed" },
  ];
  const report = await runProbes("http://door", fakeDoor(rows, "red then blue"));
  expect(report.ok).toBe(true);
  expect(report.lines[0]?.detail).toBe("no reachable address to prove");
});

test("every installed vision address is probed, not just the first", async () => {
  const rows = [
    VISION_ROW,
    { id: "@/llama/ocr", role: "vision", vision: "describe", state: "installed" },
  ];
  const report = await runProbes("http://door", fakeDoor(rows, "blue then red"));
  expect(report.lines.map((l) => l.address)).toEqual(["@/llama/see", "@/llama/ocr"]);
  expect(report.ok).toBe(false);
});

test("a door that cannot answer for its own menu fails rather than reporting nothing to prove", async () => {
  const report = await runProbes("http://door", fakeDoor([], "", 503));
  expect(report.ok).toBe(false);
  expect(report.lines[0]?.detail).toContain("503");
});

test("a door that cannot be reached at all fails", async () => {
  const dead = ((input: string | URL | Request) =>
    Promise.reject(new Error(`ECONNREFUSED ${String(input)}`))) as typeof fetch;
  const report = await runProbes("http://door", dead);
  expect(report.ok).toBe(false);
  expect(report.lines[0]?.detail).toContain("ECONNREFUSED");
});

// The flag is one fact split across a unit template and an argv check, the
// same shape as RestartPreventExitStatus. Renaming it in one place leaves
// every other test green while the timer silently starts a second daemon.
test("the probe unit's ExecStart names the flag main.ts branches on", () => {
  const here = import.meta.dir;
  const unit = readFileSync(join(here, "../scripts/engined-probe.service.in"), "utf8");
  const main = readFileSync(join(here, "main.ts"), "utf8");
  const flag = unit.match(RX_EXEC_START_FLAG)?.[1];
  expect(flag).toBe("--probe");
  expect(main).toContain(`process.argv.includes("${flag}")`);
});

const RERANK_ROW = { id: "@/llama/rerank", role: "rerank", state: "installed" };
/** A transcription route that has NOT declared `translate`: the one that must refuse. */
const ENGLISH_ONLY_ROW = {
  id: "@/whisper/medium.en",
  state: "installed",
  serves: ["/openai/v1/audio/transcriptions"],
};

/** A door answering the rerank verb with `results` in the order given, best first. */
function fakeRerankDoor(rows: unknown[], order: number[]): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/engined/v1/engines")) {
      return Promise.resolve(Response.json({ contract: CONTRACT, engines: [] }));
    }
    if (url.endsWith("/openai/v1/models")) {
      return Promise.resolve(Response.json({ object: "list", data: rows }));
    }
    return Promise.resolve(
      Response.json({ results: order.map((index) => ({ index, relevance_score: 1 })) }),
    );
  }) as typeof fetch;
}

test("the rerank probe passes when the answering document is ranked first", async () => {
  // Index 1 is the docker document, the only one of the three that answers
  // the query the probe sends.
  const report = await runProbes("http://door", fakeRerankDoor([RERANK_ROW], [1, 2, 0]));

  expect(report.ok).toBe(true);
  expect(report.lines[0]?.address).toBe("@/llama/rerank");
});

// A reranker that has stopped ranking still answers 200 with well-formed
// results, which is exactly why the check is on the order and not the status.
test("the rerank probe fails when an irrelevant document is ranked first", async () => {
  const report = await runProbes("http://door", fakeRerankDoor([RERANK_ROW], [2, 1, 0]));

  expect(report.ok).toBe(false);
  expect(report.lines[0]?.detail).toContain("index 2");
});

test("a reply with no ranked results fails rather than passing on a 200", async () => {
  const noResults = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/engined/v1/engines")) {
      return Promise.resolve(Response.json({ contract: CONTRACT, engines: [] }));
    }
    return Promise.resolve(
      url.endsWith("/openai/v1/models")
        ? Response.json({ object: "list", data: [RERANK_ROW] })
        : Response.json({ results: [] }),
    );
  }) as typeof fetch;

  const report = await runProbes("http://door", noResults);

  expect(report.ok).toBe(false);
});

/** A door that answers the translations verb with `status`, and the menu with `rows`. */
function fakeTranslateDoor(rows: unknown[], status: number): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/engined/v1/engines")) {
      return Promise.resolve(Response.json({ contract: CONTRACT, engines: [] }));
    }
    return Promise.resolve(
      url.endsWith("/openai/v1/models")
        ? Response.json({ object: "list", data: rows })
        : new Response("does not serve /openai/v1/audio/translations", { status }),
    );
  }) as typeof fetch;
}

test("a transcription route that never declared translate must refuse, and passing is the refusal", async () => {
  const report = await runProbes("http://door", fakeTranslateDoor([ENGLISH_ONLY_ROW], 400));

  expect(report.ok).toBe(true);
  expect(report.lines[0]?.detail).toContain("refused");
});

// The failure this whole guard exists for: an English-only model handed the
// translate flag does not error, it transcribes -- so a 200 here is the bug.
test("a route that answers a translate request instead of refusing it fails the probe", async () => {
  const report = await runProbes("http://door", fakeTranslateDoor([ENGLISH_ONLY_ROW], 200));

  expect(report.ok).toBe(false);
  expect(report.lines[0]?.detail).toContain("instead of refusing");
});

// A route that declared it is allowed to answer, so it is not one of the
// routes this guard checks.
test("a route declaring translate is not asked to refuse", async () => {
  const declared = { ...ENGLISH_ONLY_ROW, id: "@/whisper/large-v3-turbo", translate: true };

  const report = await runProbes("http://door", fakeTranslateDoor([declared], 200));

  expect(report.lines).toHaveLength(1);
  expect(report.lines[0]?.detail).toBe("no reachable address to prove");
});

// The signal that replaced guessing from whether any row carried a `role`:
// whisper, tts and comfy routes carry none, so a box serving only those used
// to read as a stale daemon and fail weekly for a defect that was not there.
test("a door on an older contract fails once, naming the fix", async () => {
  const old = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(
      url.endsWith("/engined/v1/engines")
        ? Response.json({ contract: CONTRACT - 1, engines: [] })
        : Response.json({ object: "list", data: [] }),
    );
  }) as typeof fetch;

  const report = await runProbes("http://door", old);

  expect(report.ok).toBe(false);
  expect(report.lines).toHaveLength(1);
  expect(report.lines[0]?.detail).toContain("install.sh");
});

test("a whisper-only door proves what it can and does not read as stale", async () => {
  const report = await runProbes("http://door", fakeTranslateDoor([ENGLISH_ONLY_ROW], 400));

  expect(report.ok).toBe(true);
});

// The bug this pins: the filter read `state === "installed"`, so every
// address on an engine that was already up reported `running` and was
// skipped. The probe proved nothing exactly when the box was in use.
test("an address on an engine that is already running is still probed", async () => {
  const running = { ...VISION_ROW, state: "running" };

  const report = await runProbes("http://door", fakeDoor([running], "red then blue"));

  expect(report.lines[0]?.address).toBe("@/llama/see");
  expect(report.ok).toBe(true);
});

test("an unavailable address is left alone: /engined/v1/engines already names its fix", async () => {
  const down = { ...VISION_ROW, state: "unavailable" };

  const report = await runProbes("http://door", fakeDoor([down], "nonsense"));

  expect(report.lines).toHaveLength(1);
  expect(report.lines[0]?.detail).toBe("no reachable address to prove");
});

// The menu has to report `translate` for the refusal check to know which
// routes must refuse. When it did not, the one route allowed to translate
// looked like one that must refuse, and the probe failed on a correct config.
test("a running route that declares translate is not asked to refuse", async () => {
  const declared = {
    id: "@/whisper/large-v3-turbo",
    state: "running",
    translate: true,
    serves: ["/openai/v1/audio/transcriptions", "/openai/v1/audio/translations"],
  };

  const report = await runProbes("http://door", fakeTranslateDoor([declared], 200));

  expect(report.ok).toBe(true);
  expect(report.lines[0]?.detail).toBe("no reachable address to prove");
});
