import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appUrl = new URL("../web/app.js", import.meta.url);

test("core dashboard renderer leaves sidecar views alone", async () => {
  const source = await readFile(appUrl, "utf8");

  assert.match(source, /const sidecarViews=new Set\(\["plans","transfers","devices","workstations"\]\);/);
  assert.match(source, /if\(pageTitles\[n\]\|\|sidecarViews\.has\(n\)\)\{state\.view=n;if\(pageTitles\[n\]\)render\(\)\}/);
  assert.match(source, /function render\(\)\{if\(sidecarViews\.has\(state\.view\)\)return;/);
});
