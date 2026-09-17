import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const transfersUrl = new URL("../web/transfers.js", import.meta.url);

test("transfer rule editor owns the rtorrentGateId field natively", async () => {
  const source = await readFile(transfersUrl, "utf8");

  assert.match(source, /name="rtorrentGateId"/, "the modal form must render its own rtorrentGateId select");

  // openEditor() must seed the field from the rule being edited, so switching
  // between rules (or opening "New transfer rule") never leaks a stale gate.
  assert.match(source, /field\("rtorrentGateId"\)\.value\s*=\s*rule\?\.rtorrentGateId\s*\|\|\s*""/);

  // save() must build one payload object used for both the create (POST) and
  // update (PUT) requests, and that payload must include rtorrentGateId so an
  // edit through PUT can never silently clear the gate the way the old
  // POST-only fetch monkey-patch did.
  const payloadMatch = source.match(/const payload\s*=\s*\{[\s\S]*?\n\s*\};/);
  assert.ok(payloadMatch, "expected a single payload object literal in save()");
  assert.match(payloadMatch[0], /rtorrentGateId/, "payload must carry rtorrentGateId");

  assert.match(source, /if\(editing\)await api\(`\/v1\/local\/transfers\/\$\{encodeURIComponent\(editing\.id\)\}`,\{method:"PUT",body:payload\}\);else await api\("\/v1\/local\/transfers",\{method:"POST",body:payload\}\);/,
    "create and update must both submit the same payload object, so rtorrentGateId travels with both");
});

test("index.html no longer monkey-patches rtorrentGateId onto POST-only transfer requests", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /rtorrentGateId/, "rtorrent-gate handling must live only in transfers.js now");
});
