import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const installerUrl = new URL("../web/install.ps1", import.meta.url);

test("workstation repair tolerates legacy configs missing newer properties", async () => {
  const source = await readFile(installerUrl, "utf8");

  assert.match(source, /function Get-OptionalProperty\(\$Object, \[string\]\$Name\)/);
  assert.match(source, /\$property = \$Object\.PSObject\.Properties\[\$Name\]/);
  assert.match(source, /\$value = Get-OptionalProperty \$old \$name/);
  assert.match(source, /\$oldDeviceToken = Get-OptionalProperty \$old 'deviceToken'/);

  // Set-StrictMode Latest turns access to a missing dynamic property into the exact
  // repair failure we saw when older workstation.json files predated a new field.
  assert.doesNotMatch(source, /\$old\.\$name/);
  assert.doesNotMatch(source, /\$old\.deviceToken/);
});
