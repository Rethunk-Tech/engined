import { spawnSync } from "node:child_process";

/**
 * The local tier drives `DockerLifecycle` against the very container names
 * the installed unit owns (`engined-local-llama`, `engined-comfy`, ...), and
 * its `afterAll` shutdown stops them. Run alongside a live daemon it
 * therefore tears that daemon's own containers out from under it, leaving it
 * serving a `private_url` that refuses connections.
 *
 * Refusing is not only about the names: this workstation shares one GPU, so
 * a resident model plus a test loading its own is the second instance
 * `AGENTS.md` forbids outright.
 *
 * Throws rather than skipping. A skip here would be indistinguishable from
 * the clean skips the rest of this tier uses for a missing image, and the
 * whole point is that this one must not pass unnoticed.
 */
export function requireDaemonStopped(): void {
  const res = spawnSync("systemctl", ["--user", "is-active", "engined.service"], {
    encoding: "utf8",
  });
  if (res.stdout.trim() === "active") {
    throw new Error(
      "engined.service is running: the local tier would stop its containers and share its GPU. " +
        "Run `systemctl --user stop engined.service` first, and start it again afterwards.",
    );
  }
}
