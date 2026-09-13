import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../../.github/scripts/resolve-release-version.sh", import.meta.url));
const sha = "a".repeat(40);

function resolveRelease(overrides = {}) {
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF_NAME: "main",
    GITHUB_SHA: sha,
    INPUT_VERSION: "0.7.0-rc.1",
    INPUT_EXPECTED_SHA: sha,
    GITHUB_OUTPUT: "",
    ...overrides,
  };
  return spawnSync("bash", [script], { env, encoding: "utf8" });
}

function outputMap(stdout) {
  return Object.fromEntries(
    stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
  );
}

test("manual acceptance publishing requires exact main SHA and stays prerelease", () => {
  const result = resolveRelease();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputMap(result.stdout), { version: "0.7.0-rc.1", stable: "false" });
  assert.match(result.stderr, /publishing Nexus Backup 0\.7\.0-rc\.1/);
});

test("manual publishing rejects a stable version so latest cannot move", () => {
  const result = resolveRelease({ INPUT_VERSION: "0.7.0" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /acceptance-only.*prerelease/);
});

test("manual publishing rejects a mismatched source SHA", () => {
  const result = resolveRelease({ INPUT_EXPECTED_SHA: "b".repeat(40) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match expected_sha/);
});

test("manual publishing rejects any ref other than main", () => {
  const result = resolveRelease({ GITHUB_REF_NAME: "feature/not-main" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /allowed only from main/);
});

test("tag publishing preserves stable and prerelease semantics", () => {
  const stable = resolveRelease({
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF_NAME: "v0.7.0",
    INPUT_VERSION: "",
    INPUT_EXPECTED_SHA: "",
  });
  assert.equal(stable.status, 0, stable.stderr);
  assert.deepEqual(outputMap(stable.stdout), { version: "0.7.0", stable: "true" });

  const rc = resolveRelease({
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF_NAME: "v0.7.0-rc.2",
    INPUT_VERSION: "",
    INPUT_EXPECTED_SHA: "",
  });
  assert.equal(rc.status, 0, rc.stderr);
  assert.deepEqual(outputMap(rc.stdout), { version: "0.7.0-rc.2", stable: "false" });
});

test("tag publishing rejects non-v refs and invalid SemVer", () => {
  const branch = resolveRelease({ GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" });
  assert.notEqual(branch.status, 0);
  assert.match(branch.stderr, /v-prefixed tag/);

  const malformed = resolveRelease({ INPUT_VERSION: "acceptance-latest" });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /version must be SemVer/);
});
