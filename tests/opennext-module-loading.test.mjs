import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// OpenNext gives each request its own Next.js module loading signal, so one request never cancels
// another request's timers (workerd rejects that, and concurrent page renders hang). The rewrite
// is an AST match on Next's source. Next 16.4 changed the source and the match silently stopped,
// so check the installed OpenNext rule against the installed Next file.
const require = createRequire(import.meta.url);
const opennext = realpathSync(join(process.cwd(), "node_modules/@opennextjs/cloudflare"));
const plugin = pathToFileURL(join(opennext, "dist/cli/build/patches/plugins/module-loading.js")).href;
const astPatcher = pathToFileURL(createRequire(join(opennext, "package.json")).resolve("@opennextjs/aws/build/patch/astCodePatcher.js")).href;

test("OpenNext scopes the installed Next.js module loading signal to each request", async () => {
  const { moduleLoadingSignalRule } = await import(plugin);
  const { patchCode } = await import(astPatcher);
  const source = readFileSync(require.resolve("next/dist/server/app-render/module-loading/track-module-loading.instance.js"), "utf8");
  const patched = patchCode(source, moduleLoadingSignalRule);
  assert.notEqual(patched, source);
  assert.match(patched, /requestStore\.moduleLoadingSignal \?\?= new _cachesignal\.CacheSignal\(/);
});
