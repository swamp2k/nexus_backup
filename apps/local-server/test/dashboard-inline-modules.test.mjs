import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexPath = new URL("../web/index.html", import.meta.url);

test("dashboard no longer carries an inline enhancement module", async () => {
  const html = await readFile(indexPath, "utf8");
  const modules = [...html.matchAll(/<script\s+type="module"\s*>([\s\S]*?)<\/script>/g)];
  assert.equal(modules.length, 0, "rtorrent-gate wiring moved into transfers.js; index.html should not carry an inline fetch monkey-patch");
  assert.doesNotMatch(html, /window\.fetch\s*=\s*async/, "index.html must not monkey-patch fetch for transfer rule payloads");
});
