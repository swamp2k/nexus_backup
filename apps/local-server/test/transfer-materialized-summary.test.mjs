import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serviceUrl = new URL("../lib/transfer-rules.mjs", import.meta.url);
const migrationUrl = new URL("../../../migrations/0016_transfer_object_summary.sql", import.meta.url);

test("Transfers dashboard reads materialized counters instead of aggregating transfer_objects", async () => {
  const source = await readFile(serviceUrl, "utf8");
  assert.match(source, /FROM transfer_object_summary/);
  assert.doesNotMatch(source, /FROM transfer_objects GROUP BY rule_id, state/);
});

test("transfer summary migration backfills and maintains counters with triggers", async () => {
  const source = await readFile(migrationUrl, "utf8");
  assert.match(source, /CREATE TABLE transfer_object_summary/);
  assert.match(source, /SELECT rule_id, state, COUNT\(\*\), COALESCE\(SUM\(size\), 0\)/);
  assert.match(source, /CREATE TRIGGER transfer_object_summary_insert/);
  assert.match(source, /CREATE TRIGGER transfer_object_summary_delete/);
  assert.match(source, /CREATE TRIGGER transfer_object_summary_update/);
});
