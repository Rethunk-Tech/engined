import { readFileSync } from "node:fs";
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
 * Whether docker really holds this image. `LOCAL` is part of the answer, not a
 * caller's precondition: without the gate an ordinary `bun test` that reached
 * this file would shell out to docker per image.
 */
export function imageBuilt(image: string): boolean {
  return LOCAL && Bun.spawnSync(["docker", "image", "inspect", image]).exitCode === 0;
}

/**
 * Measured resident cost, in GiB, of the only engines large enough to contend.
 * comfy is ~42 GiB of checkpoints and llama ~30 GiB with its 262k-token KV
 * cache; every TTS and STT engine is under ~3.5 GiB (piper 0.3, kokoro ~1,
 * chatterbox ~3.3, whisper smaller still) and several are resident together
 * without contention, so a suite that loads only those needs no room check.
 */
export const ENGINE_RESIDENT_GIB = { comfy: 42, llama: 30 } as const;

/** How much of the pool to leave for everything that is not this suite's engines. */
const RESERVE_GIB = 4;

/** `/proc/meminfo` reports in kB (kibibytes, despite the spelling), which is what the pool comparison converts from. */
const KIB_PER_GIB = 1_048_576;

/** Compiled once: this runs on every local-tier suite entry, and the pattern never varies. */
const MEM_AVAILABLE = /^MemAvailable:\s+(\d+) kB$/m;

/**
 * Refuses unless the box has room for the engines this suite is about to load.
 *
 * **A running container is not a resident model.** llama-server idles with
 * nothing loaded until a request arrives, so `docker ps` routinely reports an
 * engine holding a few hundred MiB and no weights at all -- an installed unit
 * is an obstacle only while it actually holds memory this suite needs, which
 * is why this reads the pool rather than a container list or systemd.
 *
 * This APU shares one unified pool between CPU and GPU, so `MemAvailable` is
 * the constraint itself rather than a proxy for it: a model the GPU has
 * resident is already subtracted from it.
 *
 * Throws rather than skipping. A skip here would be indistinguishable from
 * the clean skips the rest of this tier uses for a missing image, and the
 * whole point is that this one must not pass unnoticed.
 */
export function requireMemoryFor(...engines: (keyof typeof ENGINE_RESIDENT_GIB)[]): void {
  // The largest, not the sum: comfy and llama are never co-resident -- a suite
  // naming both drives the swap between them, which is the one thing this box
  // has no room to do twice over.
  const needGib = Math.max(...engines.map((id) => ENGINE_RESIDENT_GIB[id])) + RESERVE_GIB;
  const meminfo = readFileSync("/proc/meminfo", "utf8");
  const kb = Number(MEM_AVAILABLE.exec(meminfo)?.[1]);
  if (!Number.isFinite(kb)) {
    throw new Error("/proc/meminfo reported no MemAvailable, so this tier cannot size the pool");
  }
  const availableGib = kb / KIB_PER_GIB;
  if (availableGib < needGib) {
    throw new Error(
      `${engines.join(" + ")} needs ~${needGib} GiB but only ${availableGib.toFixed(1)} GiB is available. ` +
        "Release what is resident (`systemctl --user stop engined.service` stops the unit's engines) and run again.",
    );
  }
}
