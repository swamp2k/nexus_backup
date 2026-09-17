import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexUrl = new URL("../web/index.html", import.meta.url);
const appUrl = new URL("../web/app.js", import.meta.url);

test("shipped UI no longer offers a direct rclone-transfer job modal", async () => {
  const [index, app] = await Promise.all([readFile(indexUrl, "utf8"), readFile(appUrl, "utf8")]);

  assert.doesNotMatch(index, /id="job-modal"/, "the direct job-creation modal markup must be removed");
  assert.doesNotMatch(index, /id="job-form"/);
  assert.doesNotMatch(index, /id="job-fields"/);

  assert.doesNotMatch(app, /openJobModal/, "app.js must not wire up direct job creation anymore");
  assert.doesNotMatch(app, /type:\s*"rclone-transfer"/, "app.js must not POST unsupported direct rclone-transfer jobs");
  assert.doesNotMatch(app, /"#new-job-button"\)\.addEventListener\("click"/, "the generic new-job button must not open a job-creation flow; only transfers.js may claim it");
});

test("the New transfer button is only wired up by the supported Transfer-rule flow", async () => {
  const transfers = await readFile(new URL("../web/transfers.js", import.meta.url), "utf8");
  assert.match(transfers, /#new-job-button/, "transfers.js should still repurpose the button for creating transfer rules");
  assert.match(transfers, /openEditor\(\)/);
});
