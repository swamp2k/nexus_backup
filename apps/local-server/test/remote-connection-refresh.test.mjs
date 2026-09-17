import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const remoteUrl = new URL("../web/remote-connection.js", import.meta.url);

test("remote connection form survives the 5-second dashboard content refresh", async () => {
  const source = await readFile(remoteUrl, "utf8");

  assert.match(source, /content\.insertAdjacentElement\("afterend",host\)/,
    "remote settings must mount outside #content so app.js refreshes cannot destroy focused inputs");
  assert.match(source, /!document\.querySelector\("#remote-connection-settings"\)/,
    "the observer must look for the stable sibling mount, not only inside #content");
  assert.doesNotMatch(source, /content\.append\(host\)/,
    "mounting the form inside #content reintroduces the refresh/input-reset bug");
});
