import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSanitizedAgentConfig } from "../lib/dashboard-data.mjs";

test("sanitized agent config never returns repository or rclone endpoint addresses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-agent-config-sanitize-"));
  try {
    const path = join(dir, "agent.json");
    const secretRepository = "rest:https://repo-user:repo-password@backup.example/private/restic";
    const inlineRclone = ":sftp,host=seed.example,user=alice,pass=obscured-secret:/incoming";
    await writeFile(path, JSON.stringify({
      sources: [{ id: "source-a", paths: ["/data/source-a"] }],
      resticRepositories: [{
        id: "repo-a",
        repository: secretRepository,
        passwordFile: "/config/secrets/restic-password",
        environment: { RESTIC_CACHE_DIR: "/state/restic-cache", AWS_SECRET_ACCESS_KEY: "aws-secret" },
      }],
      restoreTargets: [{ id: "restore-a", label: "Staging", path: "/restore/private", allowWrite: true, overwrite: "never" }],
      rcloneEndpoints: [{ id: "seedbox", fs: inlineRclone, allowMove: true, mount: { mountPoint: "/state/mounts/seedbox", vfsCacheMode: "full" } }],
      rtorrentGates: [{ id: "gate-a", url: "https://torrent-user:torrent-pass@seed.example/RPC2", password: "torrent-pass", required: true }],
    }));

    const sanitized = await loadSanitizedAgentConfig(path);
    assert.equal(sanitized.available, true);
    assert.deepEqual(sanitized.repositories, [{ id: "repo-a", kind: "rest", passwordProtected: true, cacheConfigured: true }]);
    assert.deepEqual(sanitized.endpoints, [{
      id: "seedbox", kind: "sftp", allowMove: true,
      mount: { enabled: true, vfsCacheMode: "full", vfsCacheMaxSize: null, dirCacheTime: null, pollInterval: null },
    }]);
    assert.deepEqual(sanitized.restoreTargets, [{ id: "restore-a", label: "Staging", overwrite: "never", writeEnabled: true }]);
    assert.deepEqual(sanitized.rtorrentGates, [{ id: "gate-a", required: true }]);

    const encoded = JSON.stringify(sanitized);
    for (const forbidden of [
      secretRepository, "repo-user", "repo-password", "backup.example", "/private/restic",
      "/config/secrets/restic-password", "aws-secret", inlineRclone, "seed.example", "alice", "obscured-secret",
      "/restore/private", "torrent-user", "torrent-pass", "/RPC2",
    ]) {
      assert.equal(encoded.includes(forbidden), false, `browser config leaked ${forbidden}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sanitized storage kinds reveal only coarse backend class", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-agent-config-kind-"));
  try {
    const path = join(dir, "agent.json");
    await writeFile(path, JSON.stringify({
      resticRepositories: [
        { id: "local", repository: "/backup/restic/main" },
        { id: "sftp", repository: "sftp:user@host:/srv/repo" },
        { id: "custom", repository: "secret-remote:/repo" },
      ],
      rcloneEndpoints: [
        { id: "local-endpoint", fs: "/downloads" },
        { id: "named-remote", fs: "my-private-remote:/folder" },
      ],
    }));
    const sanitized = await loadSanitizedAgentConfig(path);
    assert.deepEqual(sanitized.repositories.map((item) => [item.id, item.kind]), [
      ["local", "local"], ["sftp", "sftp"], ["custom", "remote"],
    ]);
    assert.deepEqual(sanitized.endpoints.map((item) => [item.id, item.kind]), [
      ["local-endpoint", "local"], ["named-remote", "remote"],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
