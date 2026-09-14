import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const maintenanceUrl = new URL("../web/maintenance.js", import.meta.url);

test("maintenance decorator observes only top-level view replacement", async () => {
  const source = await readFile(maintenanceUrl, "utf8");
  assert.match(source, /\.observe\(content,\{childList:true\}\)/);
  assert.doesNotMatch(source, /\.observe\(content,\{childList:true,subtree:true\}\)/);
});
