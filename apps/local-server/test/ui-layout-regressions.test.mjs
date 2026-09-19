import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const styles = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
const repositories = await readFile(new URL("../web/repositories.js", import.meta.url), "utf8");

test("settings checkbox keeps compact native-sized layout", () => {
  assert.match(styles, /\.enabled-row\{display:flex;align-items:center;gap:8px/);
  assert.match(styles, /\.enabled-row input\[type="checkbox"\]\{width:14px;height:14px;min-height:0/);
});

test("status rows stack label and value instead of concatenating them", () => {
  assert.match(styles, /\.status-row>div>strong,\.status-row>div>span\{display:block\}/);
});

test("repository folder browser does not inherit the global wide table layout", () => {
  assert.match(styles, /\.folder-browser table\{min-width:0\}/);
  assert.match(styles, /\.folder-browser \.table-wrap\{overflow:visible\}/);
});

test("repository modal keeps its primary Save action in a sticky footer", () => {
  assert.match(styles, /\.modal>form>\.modal-actions\{position:sticky/);
  assert.match(repositories, /<button type="submit" class="button primary">Save<\/button>/);
});


test("workstation drive selector keeps compact checkbox layout", () => {
  assert.match(styles, /\.ws-source-scan-controls\{display:flex;align-items:flex-end/);
  assert.match(styles, /\.ws-source-scan-controls \[data-drives\]\{display:flex;flex-wrap:wrap;gap:7px 14px/);
  assert.match(styles, /\.ws-source-scan-controls \[data-drives\] input\[type="checkbox"\]\{width:14px;height:14px;min-height:0/);
});


test("workstation source tree keeps a dedicated vertical scrollbar", () => {
  assert.match(styles, /\.ws-source-tree-table-wrap\{height:min\(420px,50vh\);min-height:180px;overflow-x:auto;overflow-y:scroll;scrollbar-gutter:stable\}/);
});
