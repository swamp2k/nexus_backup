import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const telemetryPath = fileURLToPath(new URL("../web/telemetry.js", import.meta.url));

test("workstation integrity UI parses and keeps repository credentials local", async () => {
  const source = await readFile(telemetryPath, "utf8");
  assert.doesNotThrow(() => new vm.Script(source, { filename: "telemetry.js" }));
  assert.match(source, /workstation\.integrity\.v1/);
  assert.match(source, /\/v1\/local\/workstations\/\$\{encodeURIComponent\(workstation\.id\)\}\/recovery\/check/);
  assert.match(source, /data-workstation-check/);
  assert.match(source, /Run integrity check/);
  assert.match(source, /Integrity not checked/);
  assert.match(source, /Integrity OK/);
  assert.match(source, /Integrity failed/);
  assert.match(source, /Repository location and password stay on the workstation/);
  assert.doesNotMatch(source, /data-workstation-check[^\n]*(repository|passwordFile|repositoryPath)/i);
});
