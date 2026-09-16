/**
 * Test preload (`bunfig.toml`): every `mkdtemp(tmpdir())` in the suite lands in
 * one per-run directory removed once all files finish, so a test that never
 * cleans up after itself still leaves nothing in `/tmp`, which is RAM.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const run = mkdtempSync(join(tmpdir(), "engined-run-"));
process.env.TMPDIR = run;

afterAll((): void => {
  rmSync(run, { recursive: true, force: true });
});
