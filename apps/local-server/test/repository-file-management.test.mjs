import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const gatewayPath = new URL("../bin/gateway.mjs", import.meta.url);
const repositoriesWebPath = new URL("../web/repositories.js", import.meta.url);

test("gateway wires repository download, zip-download and delete routes through the safety boundary", async () => {
  const gateway = await readFile(gatewayPath, "utf8");
  assert.match(gateway, /"\/v1\/local\/repositories\/download"[\s\S]{0,80}"GET"/);
  assert.match(gateway, /"\/v1\/local\/repositories\/download-zip"[\s\S]{0,80}"POST"/);
  assert.match(gateway, /"\/v1\/local\/repositories\/files"[\s\S]{0,80}"DELETE"/);
  assert.match(gateway, /async function deleteRepositoryPaths/);
  assert.match(gateway, /repositoryService\.paths\.resolveRelative\(relativePath, \{ allowMissing: false \}\)/);
  assert.match(gateway, /if \(!target\.relative\) throw statusError\(400, "Cannot delete the backup root"\)/);
});

// repositories.js is loaded as its own <script type="module">, so it cannot
// see functions defined in app.js/session.js's separate module scopes.
// Every module that calls toast() must define its own — the delete/download
// flows below silently died mid-function until this was caught, because a
// ReferenceError from a bare `toast(...)` call aborts everything after it.
test("repositories.js defines its own toast() instead of relying on another module's", async () => {
  const source = await readFile(repositoriesWebPath, "utf8");
  assert.match(source, /function toast\(/);
  assert.match(source, /data-delete-selected/);
  assert.match(source, /"\/v1\/local\/repositories\/files".*method:"DELETE"/);
  assert.match(source, /confirm\(`Permanently delete/);
});
