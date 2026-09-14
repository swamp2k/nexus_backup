import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const helper = new URL("../../../repository/settings.sh", import.meta.url).pathname;
const entrypoint = new URL("../../../repository/docker-entrypoint.sh", import.meta.url);
const client = new URL("../../../repository/client.sh", import.meta.url);
const dockerfile = new URL("../../../Dockerfile", import.meta.url);
const template = new URL("../../../unraid/templates/nexus-backup.xml", import.meta.url);

function run(configDir, args) {
  return spawnSync("sh", [helper, ...args], {
    encoding: "utf8",
    env: { ...process.env, NEXUS_BACKUP_REPOSITORY_CONFIG_DIR: configDir },
  });
}

test("repository exposure settings persist validated direct-Internet endpoint policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-repository-settings-"));

  assert.equal(run(dir, ["set", "exposure", "internet"]).status, 0);
  assert.equal(run(dir, ["set", "host", "backup.example.test"]).status, 0);
  assert.equal(run(dir, ["set", "listen-port", "8000"]).status, 0);
  assert.equal(run(dir, ["set", "endpoint-port", "443"]).status, 0);
  assert.equal(run(dir, ["set", "append-only", "true"]).status, 0);

  assert.equal(run(dir, ["get", "exposure"]).stdout.trim(), "internet");
  assert.equal(run(dir, ["get", "host"]).stdout.trim(), "backup.example.test");
  assert.equal(run(dir, ["get", "listen-port"]).stdout.trim(), "8000");
  assert.equal(run(dir, ["get", "endpoint-port"]).stdout.trim(), "443");
  assert.equal(run(dir, ["get", "append-only"]).stdout.trim(), "true");

  const shown = run(dir, ["show"]);
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /Exposure:\s+internet/);
  assert.match(shown.stdout, /Endpoint host:\s+backup\.example\.test/);
  assert.match(shown.stdout, /Endpoint port:\s+443/);
  assert.match(shown.stdout, /Append-only:\s+true/);
  assert.match(shown.stdout, /TLS:\s+required \(minimum TLS 1\.3\)/);
});

test("repository exposure settings reject malformed public endpoint values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-repository-settings-invalid-"));
  assert.notEqual(run(dir, ["set", "exposure", "public-ish"]).status, 0);
  assert.notEqual(run(dir, ["set", "host", "https://bad.example/path"]).status, 0);
  assert.notEqual(run(dir, ["set", "listen-port", "0"]).status, 0);
  assert.notEqual(run(dir, ["set", "endpoint-port", "70000"]).status, 0);
  assert.notEqual(run(dir, ["set", "append-only", "maybe"]).status, 0);
});

test("runtime and packaging keep direct Repository protection explicit", async () => {
  const [entrypointText, clientText, dockerfileText, templateText] = await Promise.all([
    readFile(entrypoint, "utf8"),
    readFile(client, "utf8"),
    readFile(dockerfile, "utf8"),
    readFile(template, "utf8"),
  ]);

  assert.match(entrypointText, /--tls-min-ver 1\.3/);
  assert.match(entrypointText, /--private-repos/);
  assert.match(entrypointText, /--append-only/);
  assert.match(entrypointText, /EXPOSURE.*internet/s);
  assert.match(clientText, /endpoint-port/);
  assert.match(clientText, /REPOSITORY="rest:https:\/\/\$HOST:\$PORT\/\$USER_NAME\/\$REPO_NAME"/);
  assert.match(dockerfileText, /nexus-repository-settings/);
  assert.match(templateText, /NEXUS_BACKUP_REPOSITORY_EXPOSURE/);
  assert.match(templateText, /NEXUS_BACKUP_REPOSITORY_ENDPOINT_PORT/);
  assert.match(templateText, /WAN 443 forwarded to Unraid 8000/);
});
