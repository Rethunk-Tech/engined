import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { loadSpec } from "../../src/spec.ts";
import { type EngineEntry, isContainerSpec } from "../../src/types.ts";

/**
 * The prefix this tier's own containers take, so it never names -- and on
 * teardown never stops -- a container an installed unit owns. `DockerLifecycle`
 * defaults to the unit's own prefix; every construction in this tier passes
 * this one instead.
 */
export const TEST_NAME_PREFIX = "engined-test-";

/** Set by the `test:local` script; every suite in this tier is skipped without it. */
export const LOCAL = process.env.ENGINED_LOCAL === "1";

/** The repo's real `engines/` dir -- specs are read as-shipped, never a fixture copy. */
export const ENGINES_ROOT = join(import.meta.dir, "..", "..", "engines");

/** This operator's own real config, loaded as-is: a clean parse here is also a live proof it still matches the machine. */
export const CONFIG_EXAMPLE = join(import.meta.dir, "..", "..", "config.example.toml");

/**
 * The real `bunx` on this box's PATH. Falls back to the bare command name
 * rather than `undefined`, so a suite that never resolves an agentic
 * `{bunx}` placeholder can still build a spec.
 */
export const BUNX = process.env.ENGINED_BUNX ?? "bunx";

/** The image tag a real, on-disk spec resolves to -- `undefined` on an unresolved placeholder or a parse failure, which every caller treats as a clean skip. */
export function specImage(engine: EngineEntry): string | undefined {
  try {
    const loaded = loadSpec(engine, {
      enginesRoot: ENGINES_ROOT,
      bunx: BUNX,
      presetIni: "/unused",
    });
    return isContainerSpec(loaded.spec) ? loaded.spec.image : undefined;
  } catch {
    // Unresolved placeholder or a spec parse failure: undefined is a clean skip.
  }
}

/**
 * Refuses while any engine of the installed unit is actually running.
 *
 * This is about the GPU, not the daemon: this workstation shares one, so a
 * resident model plus a test loading its own is the second instance
 * `AGENTS.md` forbids outright. A unit that is merely *active* with every
 * engine idle-stopped holds nothing and is no obstacle, which is why the
 * check reads docker rather than systemd.
 *
 * Throws rather than skipping. A skip here would be indistinguishable from
 * the clean skips the rest of this tier uses for a missing image, and the
 * whole point is that this one must not pass unnoticed.
 */
export function requireNoResidentEngine(): void {
  const res = spawnSync("docker", ["ps", "--filter", "name=^engined-", "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  const running = res.stdout
    .split("\n")
    .map((n) => n.trim())
    .filter((n) => n.length > 0 && !n.startsWith(TEST_NAME_PREFIX));
  if (running.length > 0) {
    throw new Error(
      `engined containers are running and hold the GPU: ${running.join(", ")}. ` +
        "Stop them (or `systemctl --user stop engined.service`) and run again.",
    );
  }
}
