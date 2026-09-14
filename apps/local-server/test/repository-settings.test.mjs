import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositorySettingsService } from "../lib/repository-settings.mjs";

test("repository settings default Internet mode to append-only and separate listen/endpoint ports", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-repository-service-"));
  const configDir = join(root, "config");
  const runtimeDir = join(root, "run");
  const service = createRepositorySettingsService({
    configDir,
    runtimeDir,
    env: {
      NEXUS_BACKUP_REPOSITORY_EXPOSURE: "internet",
      NEXUS_BACKUP_REPOSITORY_HOST: "backup.example.test",
      NEXUS_BACKUP_REPOSITORY_PORT: "8000",
      NEXUS_BACKUP_REPOSITORY_ENDPOINT_PORT: "443",
    },
  });

  const initial = await service.get();
  assert.deepEqual(initial.configured, {
    exposure: "internet",
    host: "backup.example.test",
    listenPort: 8000,
    endpointPort: 443,
    appendOnly: true,
  });
  assert.equal(initial.active, null);
  assert.equal(initial.restartRequired, false);
  assert.equal(initial.protections.tlsMinVersion, "1.3");
  assert.equal(initial.protections.rateLimit, false);

  const saved = await service.update({ endpointPort: 8443, appendOnly: false });
  assert.equal(saved.configured.endpointPort, 8443);
  assert.equal(saved.configured.appendOnly, false);
  assert.equal(saved.restartRequired, true);
  assert.equal((await readFile(join(configDir, "settings", "endpoint-port"), "utf8")).trim(), "8443");
  assert.equal((await readFile(join(configDir, "settings", "append-only"), "utf8")).trim(), "false");
});

test("repository settings compare saved policy to running Repository status", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-repository-active-"));
  const configDir = join(root, "config");
  const runtimeDir = join(root, "run");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "repository-active.json"), JSON.stringify({
    exposure: "internet",
    host: "backup.example.test",
    listenPort: 8000,
    endpointPort: 443,
    appendOnly: true,
  }));
  const service = createRepositorySettingsService({
    configDir,
    runtimeDir,
    env: {
      NEXUS_BACKUP_REPOSITORY_EXPOSURE: "internet",
      NEXUS_BACKUP_REPOSITORY_HOST: "backup.example.test",
      NEXUS_BACKUP_REPOSITORY_PORT: "8000",
      NEXUS_BACKUP_REPOSITORY_ENDPOINT_PORT: "443",
    },
  });

  assert.equal((await service.get()).restartRequired, false);
  await service.update({ host: "new.example.test" });
  const changed = await service.get();
  assert.equal(changed.restartRequired, true);
  assert.equal(changed.active.host, "backup.example.test");
  assert.equal(changed.configured.host, "new.example.test");
});

test("repository settings reject unsafe or malformed values", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-repository-invalid-service-"));
  const service = createRepositorySettingsService({
    configDir: join(root, "config"),
    runtimeDir: join(root, "run"),
    env: {
      NEXUS_BACKUP_REPOSITORY_EXPOSURE: "lan",
      NEXUS_BACKUP_REPOSITORY_HOST: "tower.local",
      NEXUS_BACKUP_REPOSITORY_PORT: "8000",
    },
  });

  await assert.rejects(() => service.update({ exposure: "public" }), /lan or internet/);
  await assert.rejects(() => service.update({ host: "https:\/\/bad.example\/repo" }), /unsupported characters/);
  await assert.rejects(() => service.update({ endpointPort: 0 }), /between 1 and 65535/);
  await assert.rejects(() => service.update({ appendOnly: "yes" }), /true or false/);
});
