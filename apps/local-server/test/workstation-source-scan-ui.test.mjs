import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sessionUrl = new URL("../web/session.js", import.meta.url);

test("workstation source-scan UI restores drive selection, polling, live progress and cached tree", async () => {
  const source = await readFile(sessionUrl, "utf8");

  // Selectable drives before scanning (previously hardcoded to ws.status.localDrives).
  assert.match(source, /data-drives/, "expected a drive checkbox list in the sources modal");
  assert.match(source, /\[data-drives\] input:checked/, "the scan request must use the operator-selected drives");
  assert.doesNotMatch(source, /drives:\s*ws\.status\?\.localDrives\s*\?\?\s*\[\]/, "must not silently scan every reported drive without letting the operator choose");

  // Polling of the async source-scan run after queueing it.
  assert.match(source, /for\s*\(let i = 0; i < 300; i\+\+\)/, "expected a bounded poll loop after queueing a TreeSize scan");
  assert.match(source, /data\.run\?\.id === queued\.run\?\.id && data\.run\?\.terminal/, "polling must stop once the queued run reaches a terminal state");

  // Live TreeSize phase/progress/status while a scan is active.
  assert.match(source, /run\.progress/, "expected the active run's progress to be surfaced");
  assert.match(source, /progress\.filesDone/);
  assert.match(source, /progress\.currentPath/);

  // Cached scan tree / folder-selection behavior, expanding without rescanning.
  assert.match(source, /renderChildren/, "expected hierarchical tree rendering from the cached scan");
  assert.match(source, /data-path/, "expected per-folder selection checkboxes reading the saved scan");
  assert.match(source, /compactSourcePaths/, "expected nested folder selections to be compacted before saving");
});
