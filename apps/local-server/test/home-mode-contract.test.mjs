import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const installer = await readFile(new URL("../web/install.ps1", import.meta.url), "utf8");
const gateway = await readFile(new URL("../bin/gateway.mjs", import.meta.url), "utf8");
const repository = await readFile(new URL("../../../repository/docker-entrypoint.sh", import.meta.url), "utf8");

test("Home mode is automatic and does not ACL-hide workstation config", () => {
  assert.match(installer, /repository-profile/);
  assert.match(installer, /insecureNoPassword/);
  assert.doesNotMatch(installer, /\/inheritance:r/);
  assert.match(installer, /\/inheritance:e/);
  assert.match(gateway, /mode: "home"/);
  assert.match(gateway, /rest:http:\/\//);
});

test("LAN repository is no-auth HTTP while Remote mode retains hardening", () => {
  assert.match(repository, /--no-auth/);
  assert.match(repository, /if \[ "\$EXPOSURE" = "internet" \]/);
  assert.match(repository, /--private-repos/);
  assert.match(repository, /--tls-min-ver 1\.3/);
});
