/**
 * The floor is a mount table, so it is tested by mounting it: the argv is
 * checked for the ordering the guarantee rests on, and then actually run, so
 * a reordering that silently leaves the workdir writable fails here rather
 * than in production. `bwrap` is a real dependency and unprivileged, so there
 * is nothing to fake.
 */

import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxArgv } from "./sandbox.ts";
import { makeTestRoot } from "./test-support.ts";

const BWRAP = "/usr/bin/bwrap";
const TEST_ROOT = makeTestRoot("engined-sandbox-test-");

function scratch(prefix: string): string {
  return mkdtempSync(join(TEST_ROOT, prefix));
}

function run(argv: readonly string[]): { code: number; stderr: string } {
  const proc = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, stderr: proc.stderr.toString() };
}

it("binds the whole filesystem read-only before carving anything back out", () => {
  const argv = sandboxArgv({ bwrap: BWRAP, home: "/h", workdir: "/w", argv: ["/bin/true"] });
  // Order is the mechanism: a later bind wins, so the read-only root has to be
  // first and the workdir's own read-only bind has to come after the home's.
  expect(argv.slice(0, 4)).toEqual([BWRAP, "--ro-bind", "/", "/"]);
  expect(argv.indexOf("--bind")).toBeLessThan(argv.lastIndexOf("--ro-bind"));
  expect(argv.slice(argv.lastIndexOf("--ro-bind"))).toEqual([
    "--ro-bind",
    "/w",
    "/w",
    "--die-with-parent",
    "--",
    "/bin/true",
  ]);
});

it("refuses a write into the workdir, which is the whole guarantee", () => {
  const workdir = scratch("engined-sandbox-work-");
  const home = scratch("engined-sandbox-home-");
  writeFileSync(join(workdir, "seed.txt"), "pre-existing\n");
  const { code, stderr } = run(
    sandboxArgv({
      bwrap: BWRAP,
      home,
      workdir,
      argv: ["/bin/sh", "-c", `printf x > ${workdir}/written.txt`],
    }),
  );
  expect(code).not.toBe(0);
  expect(stderr).toContain("Read-only file system");
  expect(existsSync(join(workdir, "written.txt"))).toBe(false);
});

it("refuses to overwrite a file that already exists, not merely to create one", async () => {
  const workdir = scratch("engined-sandbox-work-");
  const home = scratch("engined-sandbox-home-");
  const seed = join(workdir, "seed.txt");
  writeFileSync(seed, "pre-existing\n");
  const { code } = run(
    sandboxArgv({ bwrap: BWRAP, home, workdir, argv: ["/bin/sh", "-c", `printf x > ${seed}`] }),
  );
  expect(code).not.toBe(0);
  expect(await Bun.file(seed).text()).toBe("pre-existing\n");
});

it("leaves the agent its own state directory writable, or it cannot cache anything", () => {
  const workdir = scratch("engined-sandbox-work-");
  const home = scratch("engined-sandbox-home-");
  const { code } = run(
    sandboxArgv({
      bwrap: BWRAP,
      home,
      workdir,
      argv: ["/bin/sh", "-c", `printf x > ${home}/session.json`],
    }),
  );
  expect(code).toBe(0);
  expect(existsSync(join(home, "session.json"))).toBe(true);
});

it("gives a writable temp directory, since an agent that cannot write one looks broken", () => {
  const workdir = scratch("engined-sandbox-work-");
  const home = scratch("engined-sandbox-home-");
  const { code } = run(
    sandboxArgv({ bwrap: BWRAP, home, workdir, argv: ["/bin/sh", "-c", "printf x > /tmp/t"] }),
  );
  expect(code).toBe(0);
});
