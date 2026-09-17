import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { copyFlatBackup } from "../lib/flat-file-backup.mjs";
import { createRepositoryService } from "../lib/repositories.mjs";
import { createReceiverUserService } from "../lib/receiver-users.mjs";
import { createRemoteConnectionService } from "../lib/remote-connection.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const repositoriesWebPath = fileURLToPath(new URL("../web/repositories.js", import.meta.url));
const installerPath = fileURLToPath(new URL("../web/install.ps1", import.meta.url));

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nexus-flat-file-"));
  const db = await openSqliteD1({ filename: join(dir, "nexus.sqlite"), migrationsDir });
  const repositories = createRepositoryService({ db, backupRoot: join(dir, "backup"), id: () => "repo-family" });
  let receiverSequence = 0;
  const receiverUsers = createReceiverUserService({ db, repositories, id: () => `receiver-${++receiverSequence}` });
  return { dir, db, repositories, receiverUsers, async close() { db.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("repository creation creates a browsable folder and rejects traversal", async () => {
  const f = await fixture();
  try {
    const repository = await f.repositories.create({ name: "Family PCs" });
    assert.equal(repository.relativePath, "Family PCs");
    const browsed = await f.repositories.browse("");
    assert.equal(browsed.entries[0].name, "Family PCs");
    await assert.rejects(() => f.repositories.browse("../outside"), /unsafe|under \/backup/);
    await assert.rejects(() => f.repositories.create({ name: "Other", relativePath: "Family PCs/../outside" }), /unsafe/);
  } finally { await f.close(); }
});

test("repository browser consumes typed directory entries and workstation installer omits receiver transport secrets", async () => {
  const browser = await readFile(repositoriesWebPath, "utf8");
  assert.match(browser, /filter\(item=>item\.type==="directory"\)/);
  assert.doesNotMatch(browser, /filter\(item=>item\.directory\)/);
  const installer = await readFile(installerPath, "utf8");
  assert.match(installer, /repositoryId=/);
  assert.doesNotMatch(installer, /receiverProtocol=/);
  assert.doesNotMatch(installer, /receiverHost=/);
  assert.doesNotMatch(installer, /receiverPassword=/);
  assert.doesNotMatch(installer, /@\('pollSeconds','reportSeconds','receiverPassword'\)/);
  assert.match(browser, /user\.kind==="manual"/);
});

test("receiver users get random credentials and a restricted root", async () => {
  const f = await fixture();
  try {
    const repository = await f.repositories.create({ name: "Family" });
    const created = await f.receiverUsers.create({ username: "Camera Upload", repositoryId: repository.id, relativeSubpath: "Camera Uploads" });
    assert.match(created.user.username, /^camera-upload$/);
    assert.ok(created.password.length >= 20);
    assert.equal((await f.receiverUsers.authenticate(created.user.username, created.password)).id, created.user.id);
    await assert.rejects(() => f.receiverUsers.authenticate(created.user.username, "wrong-password-that-is-long-enough"), /Invalid/);
    const root = await f.receiverUsers.resolvePath(created.user.username, "photo.jpg");
    assert.match(root.relativePath, /Family\/Camera Uploads\/photo\.jpg$/);
    await assert.rejects(() => f.receiverUsers.resolvePath(created.user.username, "../other"), /unsafe|outside/);
    await f.db.prepare(`INSERT INTO managed_devices(id,name,kind,token_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
      .bind("ws-1", "Balder PC", "workstation", "hash-ws-1", new Date().toISOString(), new Date().toISOString()).run();
    const workstation = await f.receiverUsers.create({ username: "Balder PC", repositoryId: repository.id, kind: "workstation", workstationId: "ws-1" });
    assert.equal(await f.receiverUsers.consumeBootstrapPassword("ws-1"), workstation.password);
    assert.equal(await f.receiverUsers.consumeBootstrapPassword("ws-1"), null);
    const reset = await f.receiverUsers.resetPassword(workstation.user.id, "fresh-workstation-bootstrap-password");
    assert.equal(Object.hasOwn(reset, "password"), false);
    assert.equal(await f.receiverUsers.authenticate(workstation.user.username, "fresh-workstation-bootstrap-password").then((user) => user.id), workstation.user.id);
  } finally { await f.close(); }
});

test("flat-file backup writes readable files and never mirrors deletions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-copy-"));
  try {
    const source = join(dir, "Documents"); const destination = join(dir, "backup", "Family", "PC");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "notes.txt"), "hello");
    const result = await copyFlatBackup({ sourcePaths: [source], destinationRoot: destination });
    assert.equal(result.files, 1);
    assert.equal(await readFile(join(destination, "Documents", "notes.txt"), "utf8"), "hello");
    await rm(join(source, "notes.txt"));
    await copyFlatBackup({ sourcePaths: [source], destinationRoot: destination });
    assert.equal(await readFile(join(destination, "Documents", "notes.txt"), "utf8"), "hello");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("symlinked repository folders cannot escape the backup root", async () => {
  const f = await fixture();
  try {
    const outside = join(f.dir, "outside"); await mkdir(outside);
    try { await symlink(outside, join(f.dir, "backup", "escape"), "junction"); } catch { return; }
    await assert.rejects(() => f.repositories.browse("escape"), /under \/backup/);
  } finally { await f.close(); }
});

test("remote HTTP access stays LAN-only until an exact hostname is enabled", async () => {
  const f = await fixture();
  try {
    const remote = createRemoteConnectionService({ db: f.db });
    assert.equal(await remote.allowsHost("192.168.1.20:8787"), true);
    assert.equal(await remote.allowsHost("tower:8787"), true);
    assert.equal(await remote.allowsHost("nexusbackup"), true);
    assert.equal(await remote.allowsHost("nexusbackup.local:8787"), true);
    assert.equal(await remote.allowsHost("outside.example:8787"), false);
    await assert.rejects(() => remote.update({ enabled: true, allowedHostname: "*.example.com" }), /hostname/);
    await remote.update({ enabled: true, allowedHostname: "backup.example.com" });
    assert.equal(await remote.allowsHost("backup.example.com"), true);
    assert.equal(await remote.allowsHost("other.example.com"), false);
  } finally { await f.close(); }
});
