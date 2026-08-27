/**
 * Startup exit codes, proven by spawning `src/main.ts` rather than by calling
 * into it: the thing under test is what the process exits with, and only a
 * real spawn observes that. The unit carries `RestartPreventExitStatus=78`,
 * so an exit code of 1 here is not a cosmetic difference -- it is a restart
 * loop against a fault no restart can clear.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { FatalError } from "./types.ts";

/** An XDG pair that redirects both `configPath()` and `installDir()` at a scratch tree. */
function scratchHome(
  specBody: string,
  configBody: string,
): { XDG_CONFIG_HOME: string; XDG_DATA_HOME: string } {
  const base = mkdtempSync(join(tmpdir(), "engined-startup-"));
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
