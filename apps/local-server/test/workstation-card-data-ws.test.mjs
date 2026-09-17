import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workstation cards emit the data-ws hook maintenance.js requires to render Update / repair", async () => {
  const [session, maintenance] = await Promise.all([
    readFile(new URL("../web/session.js", import.meta.url), "utf8"),
    readFile(new URL("../web/maintenance.js", import.meta.url), "utf8"),
  ]);

  // maintenance.js only decorates cards matching this selector.
  const selectorMatch = maintenance.match(/content\.querySelectorAll\("([^"]*workstation-card[^"]*)"\)/);
  assert.ok(selectorMatch, "expected maintenance.js to select workstation cards by a CSS selector");
  assert.equal(selectorMatch[1], ".workstation-card[data-ws]");

  // session.js's card() template must actually emit that attribute (with the
  // workstation id) on the same element that carries the workstation-card class.
  const cardMatch = session.match(/<section class="card workstation-card"[^`]*?>/);
  assert.ok(cardMatch, "expected the workstation card's opening tag in session.js");
  assert.match(cardMatch[0], /data-ws="\$\{attr\(ws\.id\)\}"/, "the card element must carry data-ws=<workstation id>");
});
