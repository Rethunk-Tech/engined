import { spawnSync } from "node:child_process";

/**
 * The prefix this tier's own containers take, so it never names -- and on
 * teardown never stops -- a container an installed unit owns. `DockerLifecycle`
 * defaults to the unit's own prefix; every construction in this tier passes
 * this one instead.
 */
export const TEST_NAME_PREFIX = "engined-test-";

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
