import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../web/repositories.js", import.meta.url), "utf8");

test("repository save reads named form controls instead of HTMLFormElement.name", () => {
  assert.match(source, /form\.elements\.namedItem\(name\)/);
  assert.match(source, /field\(form,"name"\)\.value/);
  assert.match(source, /field\(form,"relativePath"\)\.value/);
  assert.doesNotMatch(source, /form\.name\.value/);
  assert.doesNotMatch(source, /form\.relativePath\.value/);
});
