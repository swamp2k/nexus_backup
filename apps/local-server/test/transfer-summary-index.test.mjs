import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../migrations/0015_transfer_summary_index.sql", import.meta.url);

test("transfer summary aggregation has a covering index", async () => {
  const source = await readFile(migrationUrl, "utf8");
  assert.match(source, /CREATE INDEX idx_transfer_objects_summary/);
  assert.match(source, /transfer_objects\(rule_id, state, size\)/);
});
