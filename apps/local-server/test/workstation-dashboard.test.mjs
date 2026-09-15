import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sessionPath = new URL("../web/session.js", import.meta.url);

test("workstation recovery badge update is idempotent under its content observer", async () => {
  const source = await readFile(sessionPath, "utf8");
  const enhancerStart = source.indexOf("function enhanceCards()");
  const enhancerEnd = source.indexOf("function openRecovery(ws)", enhancerStart);
  assert.notEqual(enhancerStart, -1, "recovery card enhancer should exist");
  assert.notEqual(enhancerEnd, -1, "recovery dialog opener should follow the enhancer");
  assert.match(
    source.slice(enhancerStart, enhancerEnd),
    /setTextContentIfChanged\(badge,"M7 recovery"\)/,
    "the observed Workstations subtree must not be rewritten when the badge already matches",
  );

  const enhancerSource = source.slice(enhancerStart, enhancerEnd);
  const helperSource = source.match(/function setTextContentIfChanged\(element,value\)\{[^}]*\}/)?.[0];
  assert.ok(helperSource, "the idempotent text helper should exist");
  const setTextContentIfChanged = new Function(`${helperSource}; return setTextContentIfChanged;`)();

  const callbacks = [];
  let observerQueued = false;
  let observerCallbacks = 0;
  let writes = 0;
  let text = "M6 workstation";
  const badge = {
    get textContent() { return text; },
    set textContent(value) {
      writes++;
      text = value;
      if (!observerQueued) {
        observerQueued = true;
        callbacks.push(() => {
          observerQueued = false;
          observerCallbacks++;
          enhanceCards();
        });
      }
    },
  };
  const content = { querySelectorAll: () => [], querySelector: () => badge };
  const enhanceCards = new Function(
    "active", "content", "workstations", "setTextContentIfChanged",
    `${enhancerSource}; return enhanceCards;`,
  )(() => true, content, [], setTextContentIfChanged);

  enhanceCards();
  while (callbacks.length && observerCallbacks < 10) callbacks.shift()();
  enhanceCards(); // An unchanged refresh must not schedule another observer callback.

  assert.equal(observerCallbacks, 1, "the first badge update should cause one observer callback");
  assert.equal(writes, 1, "observer and refresh callbacks must not create repeated child-list mutations");
  assert.equal(callbacks.length, 0, "an unchanged badge must not queue another observer callback");
  assert.equal(text, "M7 recovery");
});
