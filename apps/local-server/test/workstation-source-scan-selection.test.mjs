import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sessionUrl = new URL("../web/session.js", import.meta.url);

test("TreeSize folder selection stays authoritative across lazy/collapsed branches", async () => {
  const source = await readFile(sessionUrl, "utf8");

  // `selected` must be initialized once from the policy and never rebuilt by
  // (re-)rendering the tree; renderTree()/renderChildren() only read it.
  const openSourcesMatch = source.match(/async function openSources\(ws\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(openSourcesMatch, "expected to locate openSources()");
  const body = openSourcesMatch[0];
  const selectedDecls = body.match(/const selected = new Set\(/g) || [];
  assert.equal(selectedDecls.length, 1, "selected must be declared exactly once, outside renderTree/renderChildren");

  // Every rendered [data-path] checkbox must update the authoritative Set on
  // change, so toggling a folder is never lost when its row is re-rendered
  // (e.g. after a rescan) or when a sibling branch is collapsed.
  assert.match(body, /querySelector\("\[data-path\]"\)\.addEventListener\("change"/,
    "expected a change listener on each rendered per-folder checkbox");
  assert.match(body, /if\s*\(event\.currentTarget\.checked\)\s*selected\.add\(node\.path\);\s*else\s*selected\.delete\(node\.path\);/,
    "expected the checkbox listener to add/remove node.path from `selected`");

  // Saving must read from the authoritative Set, not from whichever checkboxes
  // happen to be mounted in the DOM right now -- a collapsed/never-expanded
  // branch has no [data-path] elements in the DOM at all, so querying the DOM
  // silently drops previously configured child folders.
  assert.match(body, /const paths = compactSourcePaths\(\[\.\.\.selected\]\);/,
    "Save selected folders must build paths from [...selected], not modal.querySelectorAll(\"[data-path]:checked\")");
  assert.doesNotMatch(body, /querySelectorAll\("\[data-path\]:checked"\)/,
    "must not reconstruct the saved paths by querying only the currently rendered/expanded checkboxes");
});
