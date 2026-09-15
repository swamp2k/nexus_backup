import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dockerfileUrl = new URL("../../../Dockerfile", import.meta.url);
const indexUrl = new URL("../web/index.html", import.meta.url);

test("appliance image injects version and short revision into dashboard sidebar", async () => {
  const [dockerfile, index] = await Promise.all([
    readFile(dockerfileUrl, "utf8"),
    readFile(indexUrl, "utf8"),
  ]);
  assert.match(index, /No cloud dependency/);
  assert.match(dockerfile, /NEXUS_BACKUP_VERSION/);
  assert.match(dockerfile, /NEXUS_BACKUP_REVISION/);
  assert.match(dockerfile, /cut -c1-8/);
  assert.match(dockerfile, /No cloud dependency/);
});
