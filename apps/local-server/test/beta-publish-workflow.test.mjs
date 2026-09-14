import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../../.github/workflows/publish-beta.yml", import.meta.url);

test("beta image publishes only after successful main CI", async () => {
  const source = await readFile(workflowUrl, "utf8");

  assert.match(source, /workflow_run:/);
  assert.match(source, /workflows:\s*\n\s*- CI/);
  assert.match(source, /branches:\s*\n\s*- main/);
  assert.match(source, /workflow_run\.conclusion == 'success'/);
  assert.match(source, /workflow_run\.event == 'push'/);
  assert.match(source, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(source, /git rev-parse origin\/main/);
  assert.match(source, /type=raw,value=beta/);
  assert.match(source, /NEXUS_BACKUP_REVISION=\$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
});
