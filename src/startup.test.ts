/**
 * Startup exit codes, proven by spawning `src/main.ts` rather than by calling
 * into it: the thing under test is what the process exits with, and only a
 * real spawn observes that. The unit carries `RestartPreventExitStatus=78`,
 * so an exit code of 1 here is not a cosmetic difference -- it is a restart
 * loop against a fault no restart can clear.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { makeTestRoot } from "./test-support.ts";
import { FatalError } from "./types.ts";

const TEST_ROOT = makeTestRoot("engined-startup-test-");
const RX_RESTART_PREVENT_EXIT_STATUS = /^RestartPreventExitStatus=(\d+)$/m;

/** An XDG pair that redirects both `configPath()` and `installDir()` at a scratch tree. */
function scratchHome(
  specBody: string,
  configBody: string,
): { XDG_CONFIG_HOME: string; XDG_DATA_HOME: string } {
  const base = mkdtempSync(join(TEST_ROOT, "engined-startup-"));
  const configHome = join(base, "config");
  const dataHome = join(base, "data");
  mkdirSync(join(configHome, "engined"), { recursive: true });
  mkdirSync(join(dataHome, "engined", "engines", "probe"), { recursive: true });
  writeFileSync(join(configHome, "engined", "config.toml"), configBody);
  writeFileSync(join(dataHome, "engined", "engines", "probe", "spec.toml"), specBody);
  return { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome };
}

async function runDaemon(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

// A spec placeholder the config never supplies is a parse fault, and specs load
// eagerly at construction -- so this must exit like a bad config, not like a
// crash. It fails before any listener is bound, so no port is ever claimed.
test("an unresolved spec placeholder exits 78 rather than crashing", async () => {
  const env = scratchHome(
    [
      'kind = "tts"',
      'image = "probe:local"',
      'obtain = "build"',
      'serves = ["/v1/audio/speech"]',
      "command = []",
      "",
      "[[volume]]",
      'name = "{models_dir}"',
      'path = "/models"',
      "",
      "[ready]",
      'path   = "/health"',
      "status = 200",
    ].join("\n"),
    ["listen_port = 39218", "", "[[engine]]", 'id     = "probe"', 'egress = "none"'].join("\n"),
  );
  const { code, stderr } = await runDaemon(env);
  expect(code).toBe(FatalError.EXIT_CODE);
  expect(stderr).toContain("unresolved placeholder {models_dir}");
});

// A port already bound (by anything, not necessarily another engined) is
// fatal rather than a restart-loop candidate -- proven live earlier this
// session by holding the real 29200 and starting the unit (status=78/CONFIG,
// NRestarts=0). 39219 here is a second, distinct scratch port from
// startup.test.ts's other test (39218) -- never 29200, which the real
// engined.service is bound to and serving on right now.
test("a port already bound at startup exits 78 naming the port, not a restart loop", async () => {
  const port = 39_219;
  const holder = Bun.listen({
    hostname: "127.0.0.1",
    port,
    // Bun's runtime requires at least one of data/drain, despite both being
    // typed optional -- this listener only needs to occupy the port.
    socket: {
      data() {
        // never receives real traffic; the listener exists only to hold the port
      },
    },
  });
  try {
    const env = scratchHome(
      [
        'kind = "tts"',
        'image = "probe:local"',
        'obtain = "build"',
        'serves = ["/v1/audio/speech"]',
        "command = []",
        "",
        "[ready]",
        'path   = "/health"',
        "status = 200",
      ].join("\n"),
      [`listen_port = ${port}`, "", "[[engine]]", 'id     = "probe"', 'egress = "none"'].join("\n"),
    );
    const { code, stderr } = await runDaemon(env);
    expect(code).toBe(FatalError.EXIT_CODE);
    expect(stderr).toContain(String(port));
    expect(stderr).toContain("already in use");
  } finally {
    holder.stop(true);
  }
});

// The unit's RestartPreventExitStatus and FatalError.EXIT_CODE are one fact
// split across two files that nothing else compares. Without this, changing
// the constant leaves every test green while every fatal fault becomes a
// restart loop -- the exact failure the exit code exists to prevent.
test("the unit template prevents restart on the same code FatalError exits with", () => {
  const unit = readFileSync(join(import.meta.dir, "../scripts/engined.service.in"), "utf8");
  const match = unit.match(RX_RESTART_PREVENT_EXIT_STATUS);
  expect(match?.[1]).toBe(String(FatalError.EXIT_CODE));
});
