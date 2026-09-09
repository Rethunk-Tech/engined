import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { loadConfig } from "../../src/config.ts";
import { loadSpec } from "../../src/spec.ts";
import { isContainerSpec } from "../../src/specTypes.ts";
import type { EngineEntry } from "../../src/types.ts";

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
const ENGINE_RESIDENT_GIB = { comfy: 42, llama: 30 } as const;

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
 *
 * Reading the pool is a check against one global number, so it says nothing
 * about a loader in another process: two runs that each pass here still load
 * together and OOM the box, which is why `test:local` holds a `flock` for the
 * whole tier rather than relying on this call alone. The kernel drops that
 * lock if the run dies, which a lockfile this code wrote and deleted would not.
 */
/**
 * Short, and refreshed while the suite runs, so a run killed mid-hold costs the
 * operator's door at most this long rather than the whole TTL. The refresh timer
 * is unref'd: it must not be what keeps the test process alive.
 */
const HOLD_SECONDS = 120;
const HOLD_REFRESH_MS = 60_000;

/**
 * Asks the running unit to stop these engines and keep them stopped.
 *
 * This is the half `requireMemoryFor` cannot do on its own. Reading
 * `MemAvailable` is a check against one global number, so it says nothing about
 * what the door is about to load: llama-server idles with nothing resident
 * until a request arrives, so the pool can look ample at check time and the
 * unit can take a live request and load ~30 GiB a moment later, beside this
 * tier's own copy. A hold makes the door refuse that start instead.
 *
 * Best-effort by design: no unit running means nothing to contend with, and a
 * door that cannot be reached is not a reason to refuse to test.
 */
async function holdAtDoor(ids: readonly string[]): Promise<void> {
  let port: number;
  try {
    port = loadConfig(CONFIG_EXAMPLE).listen_port;
  } catch {
    return;
  }
  const ask = async (verb: string): Promise<void> => {
    await Promise.all(
      ids.map(async (id) => {
        try {
          await fetch(`http://127.0.0.1:${port}/engined/v1/engines/${id}/${verb}`, {
            method: "POST",
            signal: AbortSignal.timeout(30_000),
          });
        } catch {
          // No door, or one that will not answer: nothing is holding the pool
          // against us, so there is nothing to arrange.
        }
      }),
    );
  };
  await ask(`hold?seconds=${HOLD_SECONDS}`);
  setInterval(() => {
    ask(`hold?seconds=${HOLD_SECONDS}`).catch(() => undefined);
  }, HOLD_REFRESH_MS).unref();
}

export async function requireMemoryFor(
  ...engines: (keyof typeof ENGINE_RESIDENT_GIB)[]
): Promise<void> {
  // Held before the pool is read, not after: the hold is what stops the unit
  // loading its own copy of these weights, and stopping them is also what makes
  // the reading below mean anything.
  await holdAtDoor(engines);

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
        "Release what is resident and run again -- `systemctl --user stop engined.service` stops the unit's engines, " +
        "and `systemctl --user start engined.service` puts the door back. Leaving it stopped takes the operator's door " +
        "down for every consumer, not just this run.",
    );
  }
}
