import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const defaultPath = fileURLToPath(new URL("../../../config/agent.default.json", import.meta.url));
const examplePath = fileURLToPath(new URL("../../../config/agent.example.json", import.meta.url));
const dockerfilePath = fileURLToPath(new URL("../../../Dockerfile", import.meta.url));
const splitDockerfilePaths = [
  fileURLToPath(new URL("../../../Dockerfile.local", import.meta.url)),
  fileURLToPath(new URL("../../../Dockerfile.agent", import.meta.url)),
  fileURLToPath(new URL("../../../Dockerfile.repository", import.meta.url)),
];

test("fresh agent starter config is inert and cannot target data or repositories by default", async () => {
  const config = JSON.parse(await readFile(defaultPath, "utf8"));
  for (const key of ["sources", "resticRepositories", "restoreTargets", "rcloneEndpoints", "rtorrentGates"]) {
    assert.deepEqual(config[key], [], `${key} must be empty in the starter config`);
  }
  assert.deepEqual(config.tools, {});
});

test("appliance image installs the inert Agent default rather than the worked example", async () => {
  const dockerfile = await readFile(dockerfilePath, "utf8");
  assert.match(dockerfile, /COPY config\/agent\.default\.json \.\/defaults\/agent\.json/);
  assert.doesNotMatch(dockerfile, /COPY config\/agent\.example\.json \.\/defaults\/agent\.json/);
});

test("split deployment Dockerfiles stay removed from the one-container product", async () => {
  for (const path of splitDockerfilePaths) {
    await assert.rejects(access(path, constants.F_OK), { code: "ENOENT" });
  }
});

test("worked agent example never uses the whole /data mount as a backup source", async () => {
  const config = JSON.parse(await readFile(examplePath, "utf8"));
  for (const source of config.sources ?? []) {
    for (const path of source.paths ?? []) {
      assert.notEqual(path.replace(/\/+$/, ""), "/data", "example source must be narrower than the whole /data mount");
    }
  }
});
