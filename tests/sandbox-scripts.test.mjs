import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// The sandbox copies only the scripts listed in installScripts(); a bridge import of any other file crashes every run.
test("every script the sandbox scripts import is installed into the container", () => {
  const dir = new URL("../sandbox-runner/scripts/", import.meta.url);
  const installed = readFileSync(new URL("../sandbox-runner/src/scripts.ts", import.meta.url), "utf8");
  const listed = new Set([...installed.matchAll(/from "\.\.\/scripts\/([\w-]+)\.mjs"/g)].map((m) => m[1]));
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".mjs"))) {
    const source = readFileSync(new URL(file, dir), "utf8");
    for (const [, name] of source.matchAll(/from "\.\/([\w-]+)\.mjs"/g))
      assert.ok(listed.has(name), `${file} imports ./${name}.mjs, which installScripts() does not copy into the sandbox`);
  }
  assert.ok(listed.has("review"));
});
