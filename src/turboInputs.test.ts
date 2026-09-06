import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** turbo.json is JSONC and Bun's JSON loader refuses a comment, so drop the comment lines. */
const readTurbo = (): { tasks: { test: { inputs: string[] } } } =>
  JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""));

/**
 * The first path segment of a climb out of src/, in either spelling: `join(dir,
 * "..", "engines")` and `join(dir, "../scripts/x")`. Anchored to the module
 * directory so a `".."` inside a fixture string is not read as a real path.
 */
const escapes = (body: string): string[] => {
  const anchors = [
    String.raw`import\.meta\.dir`,
    ...[...body.matchAll(/const (\w+) = import\.meta\.dir/g)].map(([, alias]) => alias),
  ];
  const pattern = new RegExp(
    String.raw`(?:${anchors.join("|")}),\s*"\.\.(?:/([^"/]+)|",\s*"([^"]+)")`,
    "g",
  );
  return [...body.matchAll(pattern)].map(([, viaSlash, viaArg]) => viaSlash ?? viaArg ?? "");
};

/**
 * `bun test src` reads shipped files no import graph reveals: the specs under
 * engines/, config.example.toml, the templates under scripts/. A read that no
 * `test` input covers is a cache key blind to the very file the assertion
 * guards, so turbo replays a green that never re-ran it.
 */
test("turbo's test inputs cover every path the suite reads outside src/", () => {
  const { inputs } = readTurbo().tasks.test;
  const covers = (path: string): boolean =>
    inputs.some((glob) => glob === path || glob.startsWith(`${path}/`));

  const read = new Set<string>();
  for (const name of readdirSync(join(ROOT, "src"))) {
    if (name.endsWith(".ts")) {
      for (const path of escapes(readFileSync(join(ROOT, "src", name), "utf8"))) {
        read.add(path);
      }
    }
  }

  expect(read).toContain("engines");
  expect(read).toContain("config.example.toml");
  expect([...read].filter((path) => !covers(path))).toEqual([]);
});
