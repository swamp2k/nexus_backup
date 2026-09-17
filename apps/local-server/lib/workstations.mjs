import { randomBytes, randomUUID } from "node:crypto";
import { nextScheduleAt } from "./backup-plans.mjs";
import { safeName } from "./backup-paths.mjs";

const ACTIVE_STATES = new Set(["queued", "leased", "running"]);
const FINAL_STATES = new Set(["completed", "partial", "failed", "cancelled"]);
const RECOVERY_OPERATIONS = new Set(["check", "inventory", "browse", "restore-preview", "restore"]);
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const PREVIEW_MAX_AGE_MS = 30 * 60 * 1000;
const SNAPSHOT_ID_RE = /^[0-9a-f]{8,64}$/i;

export function createWorkstationService({
  db,
  deviceService,
  repositories = null,
  receiverUsers = null,
  now = () => new Date(),
  id = () => `wsrun-${randomUUID()}`,
  leaseToken = () => `nxbws_${randomBytes(24).toString("base64url")}`,
  leaseMs = DEFAULT_LEASE_MS,
} = {}) {
  if (!db) throw new TypeError("db is required");
  if (!deviceService || typeof deviceService.authenticate !== "function") throw new TypeError("deviceService.authenticate is required");

  async function list() {
    const rows = (await db.prepare(`
      SELECT
        d.id,d.name,d.kind,d.enabled,d.version,d.hostname,d.platform,d.capabilities_json,d.first_seen_at,d.last_seen_at,
        p.enabled AS policy_enabled,p.source_paths_json,p.exclude_patterns_json,p.schedule_json,p.timezone,p.retention_json,
        p.repository_id,p.destination_folder,repo.name AS repository_name,repo.relative_path AS repository_path,
        p.next_run_at,p.last_scheduled_at,p.last_run_id,
        s.repository_configured,s.repository_kind,s.agent_state,s.current_run_id,s.last_backup_at,s.last_success_at,
        s.last_snapshot_id,s.last_error AS status_error,s.local_drives_json,s.updated_at AS status_updated_at,
        wr.state AS last_run_state,wr.queued_at AS last_run_queued_at,wr.started_at AS last_run_started_at,
        wr.finished_at AS last_run_finished_at,wr.progress_json AS last_run_progress_json,
        wr.result_json AS last_run_result_json,wr.error_message AS last_run_error
      FROM managed_devices d
      LEFT JOIN workstation_policies p ON p.device_id=d.id
      LEFT JOIN repositories repo ON repo.id=p.repository_id
      LEFT JOIN workstation_status s ON s.device_id=d.id
      LEFT JOIN workstation_runs wr ON wr.id=p.last_run_id
      WHERE d.kind='workstation'
      ORDER BY d.name COLLATE NOCASE ASC,d.id ASC
    `).all()).results ?? [];
    return rows.map(presentWorkstation);
  }

  async function getPolicy(deviceId) {
    const normalizedId = requireId(deviceId, "device id");
    const row = await db.prepare("SELECT * FROM workstation_policies WHERE device_id=?").bind(normalizedId).first();
    return row ? policyFromRow(row) : null;
  }

  async function putPolicy(deviceId, input) {
    const device = await requireWorkstation(deviceId);
    const policy = normalizePolicy(input);
    if (repositories && !policy.repositoryId) throw statusError(400, "repositoryId is required for workstation backups");
    if (repositories && policy.repositoryId) {
      const repository = await repositories.get(policy.repositoryId);
      if (!repository) throw statusError(404, "Repository not found");
      await repositories.resolve(repository.id, policy.destinationFolder || device.name);
    }
    const at = nowDate(now);
    const nextRunAt = policy.enabled && policy.sourcePaths.length
      ? nextScheduleAt(policy.schedule, policy.timezone, at).toISOString()
      : null;
    const existing = await getPolicy(device.id);
    if (existing) {
      await db.prepare(`
        UPDATE workstation_policies SET enabled=?,source_paths_json=?,exclude_patterns_json=?,schedule_json=?,timezone=?,
          retention_json=?,repository_id=?,destination_folder=?,next_run_at=?,updated_at=? WHERE device_id=?
      `).bind(
        policy.enabled ? 1 : 0,
        JSON.stringify(policy.sourcePaths),
        JSON.stringify(policy.excludePatterns),
        JSON.stringify(policy.schedule),
        policy.timezone,
        JSON.stringify(policy.retention),
        policy.repositoryId,
        policy.destinationFolder,
        nextRunAt,
        at.toISOString(),
        device.id,
      ).run();
    } else {
      await db.prepare(`
        INSERT INTO workstation_policies(device_id,enabled,source_paths_json,exclude_patterns_json,schedule_json,timezone,
          retention_json,repository_id,destination_folder,next_run_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        device.id,
        policy.enabled ? 1 : 0,
        JSON.stringify(policy.sourcePaths),
        JSON.stringify(policy.excludePatterns),
        JSON.stringify(policy.schedule),
        policy.timezone,
        JSON.stringify(policy.retention),
        policy.repositoryId,
        policy.destinationFolder,
        nextRunAt,
        at.toISOString(),
        at.toISOString(),
      ).run();
    }
    return await getPolicy(device.id);
  }

  async function runNow(deviceId) {
    const device = await requireWorkstation(deviceId);
    const policy = await getPolicy(device.id);
    if (!policy) throw statusError(409, "Workstation backup policy is not configured");
    if (!policy.sourcePaths.length) throw statusError(409, "Workstation backup policy has no source paths");
    const at = nowDate(now);
    const run = await queueBackupRun(device.id, policy, at.toISOString(), `workstation:${device.id}:manual:${at.toISOString()}:${randomUUID()}`);
    await db.prepare("UPDATE workstation_policies SET last_scheduled_at=?,last_run_id=?,updated_at=? WHERE device_id=?")
      .bind(at.toISOString(), run.id, at.toISOString(), device.id).run();
    return run;
  }

  async function runDue({ limit = 20 } = {}) {
    const at = nowDate(now);
    await recoverExpired();
    const normalizedLimit = clampInteger(limit, 1, 100, 20);
    const rows = (await db.prepare(`
      SELECT p.* FROM workstation_policies p
      JOIN managed_devices d ON d.id=p.device_id
      WHERE p.enabled=1 AND d.enabled=1 AND p.next_run_at IS NOT NULL AND p.next_run_at<=?
      ORDER BY p.next_run_at ASC,p.device_id ASC LIMIT ?
    `).bind(at.toISOString(), normalizedLimit).all()).results ?? [];
    let queued = 0;
    const failures = [];
    for (const row of rows) {
      const policy = policyFromRow(row);
      const scheduledFor = String(row.next_run_at);
      try {
        const run = await queueBackupRun(policy.deviceId, policy, scheduledFor, `workstation:${policy.deviceId}:${scheduledFor}`, { skipIfBusy: true });
        if (!run) continue;
        const nextRunAt = nextScheduleAt(policy.schedule, policy.timezone, at).toISOString();
        const result = await db.prepare(`
          UPDATE workstation_policies SET last_scheduled_at=?,last_run_id=?,next_run_at=?,updated_at=?
          WHERE device_id=? AND enabled=1 AND next_run_at=?
        `).bind(scheduledFor, run.id, nextRunAt, at.toISOString(), policy.deviceId, scheduledFor).run();
        if (Number(result.meta?.changes ?? 0) > 0) queued += 1;
      } catch (error) {
        failures.push({ deviceId: policy.deviceId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { queued, failures };
  }

  async function queueSourceScan(deviceId, input = {}) {
    const device = await requireWorkstation(deviceId);
    if (!device.enabled) throw statusError(409, "Workstation is disabled");
    if (!device.capabilities.includes("workstation.source-scan.v1")) throw statusError(409, "Workstation agent does not support source scans; update it first");
    if (!isOnline(device.lastSeenAt, nowDate(now))) throw statusError(409, "Workstation must be online to scan backup sources");
    const drives = normalizeSourceDrives(input?.drives);
    const active = await activeRun(device.id);
    if (active) throw statusError(409, `Workstation already has an active ${active.operation} run`);
    const at = nowDate(now).toISOString();
    const runId = requireId(id(), "generated run id");
    const operationKey = `workstation:${device.id}:source-scan:${at}:${randomUUID()}`;
    await db.prepare(`
      INSERT INTO workstation_runs(id,device_id,operation_key,state,operation,request_json,source_paths_json,exclude_patterns_json,retention_json,
        queued_at,created_at,updated_at)
      VALUES(?,?,?,'queued','source-scan',?,'[]','[]','{}',?,?,?)
    `).bind(runId, device.id, operationKey, JSON.stringify({ drives }), at, at, at).run();
    return presentRun(await db.prepare("SELECT * FROM workstation_runs WHERE id=?").bind(runId).first());
  }

  async function getSourceScan(deviceId) {
    const device = await requireWorkstation(deviceId);
    const row = await db.prepare("SELECT * FROM workstation_source_scans WHERE device_id=?").bind(device.id).first();
    const latestRun = await db.prepare(`
      SELECT * FROM workstation_runs WHERE device_id=? AND operation='source-scan' ORDER BY queued_at DESC,id DESC LIMIT 1
    `).bind(device.id).first();
    return {
      scan: row ? {
        deviceId: device.id, sourceRunId: nullableString(row.source_run_id), scannedAt: String(row.scanned_at),
        drives: parseArray(row.drives_json), nodes: parseJson(row.tree_json, []), truncated: Number(row.truncated) === 1,
      } : null,
      run: presentRun(latestRun),
    };
  }

  async function queueRecovery(deviceId, operation, input = {}) {
    const device = await requireWorkstation(deviceId);
    if (!device.enabled) throw statusError(409, "Workstation is disabled");
    if (!device.capabilities.includes("workstation.recovery.v1")) throw statusError(409, "Workstation agent does not support recovery; update it first");
    if (!isOnline(device.lastSeenAt, nowDate(now))) throw statusError(409, "Workstation must be online for recovery operations");
    const status = await db.prepare("SELECT repository_configured FROM workstation_status WHERE device_id=?").bind(device.id).first();
    if (Number(status?.repository_configured ?? 0) !== 1) throw statusError(409, "Workstation storage is not configured");

    const normalizedOperation = normalizeRecoveryOperation(operation);
    if (normalizedOperation === "check" && !device.capabilities.includes("workstation.integrity.v1")) {
      throw statusError(409, "Workstation agent does not support repository integrity checks; update it first");
    }
    const request = normalizeRecoveryRequest(normalizedOperation, input);
    if (normalizedOperation !== "inventory" && normalizedOperation !== "check") {
      await assertSnapshotKnown(device.id, request.snapshotId);
    }
    if (normalizedOperation === "browse" && request.path !== "/") {
      await assertPathKnown(device.id, request.snapshotId, request.path, { directoryOnly: true });
    }
    if ((normalizedOperation === "restore-preview" || normalizedOperation === "restore") && request.path) {
      await assertPathKnown(device.id, request.snapshotId, request.path);
    }
    if (normalizedOperation === "restore") {
      await assertRecentPreview(device.id, request);
    }

    const active = await activeRun(device.id);
    if (active) throw statusError(409, `Workstation already has an active ${active.operation} run`);
    const at = nowDate(now).toISOString();
    const runId = requireId(id(), "generated run id");
    const operationKey = `workstation:${device.id}:recovery:${normalizedOperation}:${at}:${randomUUID()}`;
    await db.prepare(`
      INSERT INTO workstation_runs(id,device_id,operation_key,state,operation,request_json,source_paths_json,exclude_patterns_json,retention_json,
        queued_at,created_at,updated_at)
      VALUES(?,?,?,'queued',?,?,'[]','[]','{}',?,?,?)
    `).bind(runId, device.id, operationKey, normalizedOperation, JSON.stringify(request), at, at, at).run();
    return presentRun(await db.prepare("SELECT * FROM workstation_runs WHERE id=?").bind(runId).first());
  }

  async function getRecoveryInventory(deviceId) {
    const device = await requireWorkstation(deviceId);
    const row = await db.prepare("SELECT * FROM workstation_snapshot_inventory WHERE device_id=?").bind(device.id).first();
    if (!row) return null;
    return {
      deviceId: device.id,
      sourceRunId: nullableString(row.source_run_id),
      scannedAt: String(row.scanned_at),
      snapshots: parseJson(row.snapshots_json, []),
    };
  }

  async function getRecoveryBrowse(deviceId, snapshotId, browsePath) {
    const device = await requireWorkstation(deviceId);
    const idValue = normalizeSnapshotId(snapshotId);
    const pathValue = normalizeSnapshotPath(browsePath, { required: true });
    const row = await db.prepare(`
      SELECT * FROM workstation_snapshot_browse WHERE device_id=? AND snapshot_id=? AND browse_path=?
    `).bind(device.id, idValue, pathValue).first();
    if (!row) return null;
    return {
      deviceId: device.id,
      snapshotId: idValue,
      path: pathValue,
      sourceRunId: nullableString(row.source_run_id),
      scannedAt: String(row.scanned_at),
      entries: parseJson(row.entries_json, []),
      entryLimit: Number(row.entry_limit),
      truncated: Number(row.truncated) === 1,
    };
  }

  async function getRun(runId) {
    const normalizedRunId = requireId(runId, "run id");
    return presentRun(await db.prepare("SELECT * FROM workstation_runs WHERE id=?").bind(normalizedRunId).first());
  }

  async function getLatestCheck(deviceId) {
    const device = await requireWorkstation(deviceId);
    return presentRun(await db.prepare(`
      SELECT * FROM workstation_runs
      WHERE device_id=? AND operation='check'
      ORDER BY queued_at DESC,id DESC LIMIT 1
    `).bind(device.id).first());
  }

  async function poll(rawToken) {
    const device = await requireAuthenticatedWorkstation(rawToken);
    await recoverExpired(device.id);
    const status = await db.prepare("SELECT repository_configured FROM workstation_status WHERE device_id=?").bind(device.id).first();
    const repositoryKnownMissing = status !== null && status !== undefined && Number(status.repository_configured) !== 1;
    const row = repositoryKnownMissing
      ? await db.prepare(`SELECT * FROM workstation_runs WHERE device_id=? AND state='queued' AND operation='source-scan' ORDER BY queued_at ASC,id ASC LIMIT 1`).bind(device.id).first()
      : await db.prepare(`SELECT * FROM workstation_runs WHERE device_id=? AND state='queued' ORDER BY queued_at ASC,id ASC LIMIT 1`).bind(device.id).first();
    if (!row) return { run: null, nextPollSeconds: 15 };
    const token = requireLeaseToken(leaseToken());
    const at = nowDate(now);
    const expiresAt = new Date(at.getTime() + leaseMs).toISOString();
    const claimed = await db.prepare(`
      UPDATE workstation_runs SET state='leased',lease_token=?,lease_expires_at=?,leased_at=COALESCE(leased_at,?),updated_at=?
      WHERE id=? AND device_id=? AND state='queued'
    `).bind(token, expiresAt, at.toISOString(), at.toISOString(), row.id, device.id).run();
    if (Number(claimed.meta?.changes ?? 0) === 0) return { run: null, nextPollSeconds: 2 };
    const current = await db.prepare("SELECT * FROM workstation_runs WHERE id=?").bind(row.id).first();
    return { run: presentRun(current, { includeLeaseToken: true }), nextPollSeconds: 15 };
  }

  async function progress(rawToken, runId, input) {
    const device = await requireAuthenticatedWorkstation(rawToken);
    const normalizedRunId = requireId(runId, "run id");
    const token = requireLeaseToken(input?.leaseToken);
    const progressValue = normalizeProgress(input?.progress ?? input);
    const at = nowDate(now);
    const expiresAt = new Date(at.getTime() + leaseMs).toISOString();
    const result = await db.prepare(`
      UPDATE workstation_runs SET state='running',started_at=COALESCE(started_at,?),progress_json=?,lease_expires_at=?,updated_at=?
      WHERE id=? AND device_id=? AND lease_token=? AND state IN ('leased','running')
    `).bind(at.toISOString(), JSON.stringify(progressValue), expiresAt, at.toISOString(), normalizedRunId, device.id, token).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw statusError(409, "Workstation run lease is stale or invalid");
    await db.prepare(`
      INSERT INTO workstation_status(device_id,repository_configured,agent_state,current_run_id,updated_at)
      VALUES(?,0,'running',?,?)
      ON CONFLICT(device_id) DO UPDATE SET agent_state='running',current_run_id=excluded.current_run_id,updated_at=excluded.updated_at
    `).bind(device.id, normalizedRunId, at.toISOString()).run();
    return presentRun(await db.prepare("SELECT * FROM workstation_runs WHERE id=?").bind(normalizedRunId).first());
  }

  async function finish(rawToken, runId, input) {
    const device = await requireAuthenticatedWorkstation(rawToken);
    const normalizedRunId = requireId(runId, "run id");
    const token = requireLeaseToken(input?.leaseToken);
    const current = await db.prepare(`
      SELECT * FROM workstation_runs WHERE id=? AND device_id=? AND lease_token=? AND state IN ('leased','running')
    `).bind(normalizedRunId, device.id, token).first();
    if (!current) throw statusError(409, "Workstation run lease is stale or invalid");
    const operation = normalizeStoredOperation(current.operation);
    const state = normalizeResultState(input?.status, operation);
    const request = parseJson(current.request_json, {});
    const resultValue = normalizeResult(input?.result, operation, request, normalizedRunId, state);
    const errorMessage = state === "failed" || state === "partial" ? optionalString(input?.error, "error", 4000) : null;
    const at = nowDate(now);
    const result = await db.prepare(`
      UPDATE workstation_runs SET state=?,finished_at=?,result_json=?,error_message=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?
      WHERE id=? AND device_id=? AND lease_token=? AND state IN ('leased','running')
    `).bind(state, at.toISOString(), resultValue ? JSON.stringify(resultValue) : null, errorMessage, at.toISOString(), normalizedRunId, device.id, token).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw statusError(409, "Workstation run lease is stale or invalid");

    if (operation === "backup") {
      const snapshotId = state === "completed" && resultValue && typeof resultValue.snapshotId === "string" ? resultValue.snapshotId.slice(0, 128) : null;
      const successAt = state === "completed" ? at.toISOString() : null;
      const repositoryConfiguredByRun = state === "completed" || state === "partial" ? 1 : 0;
      await db.prepare(`
        INSERT INTO workstation_status(device_id,repository_configured,agent_state,current_run_id,last_backup_at,last_success_at,last_snapshot_id,last_error,updated_at)
        VALUES(?,?,'idle',NULL,?,?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET repository_configured=CASE WHEN excluded.repository_configured=1 THEN 1 ELSE workstation_status.repository_configured END,
          agent_state='idle',current_run_id=NULL,last_backup_at=excluded.last_backup_at,
          last_success_at=COALESCE(excluded.last_success_at,workstation_status.last_success_at),
          last_snapshot_id=COALESCE(excluded.last_snapshot_id,workstation_status.last_snapshot_id),last_error=excluded.last_error,updated_at=excluded.updated_at
      `).bind(device.id, repositoryConfiguredByRun, at.toISOString(), successAt, snapshotId, errorMessage, at.toISOString()).run();
    } else {
      await db.prepare(`
        INSERT INTO workstation_status(device_id,repository_configured,agent_state,current_run_id,updated_at)
        VALUES(?,0,'idle',NULL,?)
        ON CONFLICT(device_id) DO UPDATE SET agent_state='idle',current_run_id=NULL,updated_at=excluded.updated_at
      `).bind(device.id, at.toISOString()).run();
      if (state === "completed") {
        if (operation === "source-scan") await persistSourceScan(device.id, normalizedRunId, resultValue, at.toISOString());
        else await persistRecoveryResult(device.id, normalizedRunId, operation, request, resultValue, at.toISOString());
      }
    }
    return presentRun(await db.prepare("SELECT * FROM workstation_runs WHERE id=?").bind(normalizedRunId).first());
  }

  async function reportStatus(rawToken, input) {
    const device = await requireAuthenticatedWorkstation(rawToken);
    const status = normalizeStatus(input);
    const at = nowDate(now).toISOString();
    await db.prepare(`
      INSERT INTO workstation_status(device_id,repository_configured,repository_kind,agent_state,current_run_id,last_backup_at,last_success_at,last_snapshot_id,last_error,local_drives_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET repository_configured=excluded.repository_configured,repository_kind=excluded.repository_kind,
        agent_state=excluded.agent_state,current_run_id=excluded.current_run_id,last_backup_at=COALESCE(excluded.last_backup_at,workstation_status.last_backup_at),
        last_success_at=COALESCE(excluded.last_success_at,workstation_status.last_success_at),
        last_snapshot_id=COALESCE(excluded.last_snapshot_id,workstation_status.last_snapshot_id),last_error=excluded.last_error,
        local_drives_json=excluded.local_drives_json,updated_at=excluded.updated_at
    `).bind(
      device.id,
      status.repositoryConfigured ? 1 : 0,
      status.repositoryKind,
      status.agentState,
      status.currentRunId,
      status.lastBackupAt,
      status.lastSuccessAt,
      status.lastSnapshotId,
      status.lastError,
      JSON.stringify(status.localDrives),
      at,
    ).run();
    return { ok: true, deviceId: device.id, nextReportSeconds: 60 };
  }

  async function recoverExpired(deviceId = null) {
    const at = nowDate(now).toISOString();
    const deviceClause = deviceId ? " AND device_id=?" : "";
    const failed = await db.prepare(`
      UPDATE workstation_runs SET state='failed',finished_at=?,lease_token=NULL,lease_expires_at=NULL,
        error_message='Restore lease expired; manual retry required',updated_at=?
      WHERE operation='restore' AND state IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at<=?${deviceClause}
      RETURNING id,device_id
    `).bind(...(deviceId ? [at, at, at, deviceId] : [at, at, at])).all();
    const requeued = await db.prepare(`
      UPDATE workstation_runs SET state='queued',lease_token=NULL,lease_expires_at=NULL,error_message='Previous lease expired; requeued',updated_at=?
      WHERE operation<>'restore' AND state IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at<=?${deviceClause}
      RETURNING id,device_id
    `).bind(...(deviceId ? [at, at, deviceId] : [at, at])).all();

    const recoveredRuns = [...failed.results, ...requeued.results];
    for (const run of recoveredRuns) {
      await db.prepare(`
        UPDATE workstation_status SET agent_state='idle',current_run_id=NULL,updated_at=?
        WHERE device_id=? AND current_run_id=?
      `).bind(at, run.device_id, run.id).run();
    }

    return recoveredRuns.length;
  }

  async function persistSourceScan(deviceId, runId, value, scannedAt) {
    await db.prepare(`
      INSERT INTO workstation_source_scans(device_id,source_run_id,scanned_at,drives_json,tree_json,truncated) VALUES(?,?,?,?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET source_run_id=excluded.source_run_id,scanned_at=excluded.scanned_at,
        drives_json=excluded.drives_json,tree_json=excluded.tree_json,truncated=excluded.truncated
    `).bind(deviceId, runId, scannedAt, JSON.stringify(value.drives), JSON.stringify(value.nodes), value.truncated ? 1 : 0).run();
  }

  async function persistRecoveryResult(deviceId, runId, operation, request, value, scannedAt) {
    if (operation === "inventory") {
      const snapshots = value.snapshots;
      await db.prepare(`
        INSERT INTO workstation_snapshot_inventory(device_id,source_run_id,scanned_at,snapshots_json) VALUES(?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET source_run_id=excluded.source_run_id,scanned_at=excluded.scanned_at,snapshots_json=excluded.snapshots_json
      `).bind(deviceId, runId, scannedAt, JSON.stringify(snapshots)).run();
      const ids = snapshots.map((item) => item.id);
      if (ids.length === 0) {
        await db.prepare("DELETE FROM workstation_snapshot_browse WHERE device_id=?").bind(deviceId).run();
      } else {
        const placeholders = ids.map(() => "?").join(",");
        await db.prepare(`DELETE FROM workstation_snapshot_browse WHERE device_id=? AND snapshot_id NOT IN (${placeholders})`).bind(deviceId, ...ids).run();
      }
      return;
    }
    if (operation === "browse") {
      await db.prepare(`
        INSERT INTO workstation_snapshot_browse(device_id,snapshot_id,browse_path,source_run_id,scanned_at,entries_json,entry_limit,truncated)
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(device_id,snapshot_id,browse_path) DO UPDATE SET source_run_id=excluded.source_run_id,scanned_at=excluded.scanned_at,
          entries_json=excluded.entries_json,entry_limit=excluded.entry_limit,truncated=excluded.truncated
      `).bind(deviceId, request.snapshotId, request.path, runId, scannedAt, JSON.stringify(value.entries), value.entryLimit, value.truncated ? 1 : 0).run();
    }
  }

  async function assertSnapshotKnown(deviceId, snapshotId) {
    const row = await db.prepare("SELECT snapshots_json FROM workstation_snapshot_inventory WHERE device_id=?").bind(deviceId).first();
    const snapshots = parseJson(row?.snapshots_json, []);
    if (!Array.isArray(snapshots) || !snapshots.some((item) => isRecord(item) && item.id === snapshotId)) {
      throw statusError(409, "Snapshot is not present in the latest workstation inventory");
    }
  }

  async function assertPathKnown(deviceId, snapshotId, selectedPath, { directoryOnly = false } = {}) {
    const rows = (await db.prepare(`
      SELECT entries_json FROM workstation_snapshot_browse WHERE device_id=? AND snapshot_id=?
    `).bind(deviceId, snapshotId).all()).results ?? [];
    for (const row of rows) {
      const entries = parseJson(row.entries_json, []);
      if (!Array.isArray(entries)) continue;
      const match = entries.find((entry) => isRecord(entry) && entry.path === selectedPath);
      if (match && (!directoryOnly || match.nodeType === "dir")) return;
    }
    throw statusError(409, directoryOnly ? "Browse path was not previously discovered as a directory" : "Restore path was not previously discovered in the snapshot browser");
  }

  async function assertRecentPreview(deviceId, request) {
    const previewRunId = requireId(request.previewRunId, "previewRunId");
    const row = await db.prepare(`
      SELECT operation,state,request_json,result_json,finished_at FROM workstation_runs WHERE id=? AND device_id=?
    `).bind(previewRunId, deviceId).first();
    if (!row || row.operation !== "restore-preview" || row.state !== "completed" || !row.finished_at) {
      throw statusError(409, "A completed restore preview is required");
    }
    const finishedAt = Date.parse(row.finished_at);
    if (!Number.isFinite(finishedAt) || nowDate(now).getTime() - finishedAt > PREVIEW_MAX_AGE_MS) {
      throw statusError(409, "Restore preview is older than 30 minutes; run it again");
    }
    const previewRequest = parseJson(row.request_json, {});
    const previewResult = parseJson(row.result_json, {});
    if (previewRequest.snapshotId !== request.snapshotId || (previewRequest.path ?? "") !== (request.path ?? "") || previewResult.dryRun !== true) {
      throw statusError(409, "Restore preview does not match the requested snapshot/path");
    }
  }

  async function activeRun(deviceId) {
    const row = await db.prepare(`SELECT id,operation,state FROM workstation_runs WHERE device_id=? AND state IN ('queued','leased','running') ORDER BY queued_at ASC LIMIT 1`).bind(deviceId).first();
    return row ? { id: String(row.id), operation: normalizeStoredOperation(row.operation), state: String(row.state) } : null;
  }

  async function requireWorkstation(deviceId) {
    const normalizedId = requireId(deviceId, "device id");
    const row = await db.prepare("SELECT id,name,kind,enabled,capabilities_json,last_seen_at FROM managed_devices WHERE id=?").bind(normalizedId).first();
    if (!row) throw statusError(404, `Device not found: ${normalizedId}`);
    if (String(row.kind) !== "workstation") throw statusError(409, `Device is not a workstation: ${normalizedId}`);
    return {
      id: String(row.id), name: String(row.name), enabled: Number(row.enabled) === 1,
      capabilities: parseArray(row.capabilities_json), lastSeenAt: nullableString(row.last_seen_at),
    };
  }

  async function requireAuthenticatedWorkstation(rawToken) {
    const device = await deviceService.authenticate(rawToken);
    if (device.kind !== "workstation") throw statusError(403, "Device token is not a workstation token");
    return device;
  }

  async function queueBackupRun(deviceId, policy, scheduledFor, operationKey, { skipIfBusy = false } = {}) {
    const existing = await db.prepare("SELECT * FROM workstation_runs WHERE operation_key=?").bind(operationKey).first();
    if (existing) return presentRun(existing);
    const active = await activeRun(deviceId);
    if (active) {
      if (skipIfBusy) return null;
      throw statusError(409, `Workstation already has an active ${active.operation} run`);
    }
    const at = nowDate(now).toISOString();
    const runId = requireId(id(), "generated run id");
    await db.prepare(`
      INSERT INTO workstation_runs(id,device_id,operation_key,state,operation,scheduled_for,source_paths_json,exclude_patterns_json,retention_json,
        queued_at,created_at,updated_at) VALUES(?,?,?,'queued','backup',?,?,?,?,?,?,?)
    `).bind(
      runId,
      deviceId,
      operationKey,
      scheduledFor,
      JSON.stringify(policy.sourcePaths),
      JSON.stringify(policy.excludePatterns),
      JSON.stringify(policy.retention),
      at,
      at,
      at,
    ).run();
    return presentRun(await db.prepare("SELECT * FROM workstation_runs WHERE id=?").bind(runId).first());
  }

  return {
    list, getPolicy, putPolicy, runNow, runDue, queueSourceScan, getSourceScan, queueRecovery, getRecoveryInventory, getRecoveryBrowse, getRun, getLatestCheck,
    poll, progress, finish, reportStatus, recoverExpired,
  };
}

export function workstationInstallCommand(origin, token) {
  const base = String(origin ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new RangeError("origin must be http(s)");
  if (typeof token !== "string" || !token.startsWith("nxbdev_")) throw new RangeError("workstation token is invalid");
  const q = (value) => String(value).replace(/'/g, "''");
  return `$env:NEXUS_BACKUP_URL='${q(base)}';$env:NEXUS_BACKUP_TOKEN='${q(token)}';irm '${q(base)}/install.ps1'|iex`;
}

function normalizePolicy(value) {
  if (!isRecord(value)) throw new RangeError("policy must be an object");
  const enabled = value.enabled === undefined ? true : requireBoolean(value.enabled, "enabled");
  const sourcePaths = uniqueStrings(value.sourcePaths, "sourcePaths", 32, 1024);
  const excludePatterns = uniqueStrings(value.excludePatterns, "excludePatterns", 128, 512);
  const schedule = normalizeSchedule(value.schedule ?? { kind: "daily", time: "02:00" });
  const timezone = normalizeTimezone(value.timezone ?? "UTC");
  const retentionValue = isRecord(value.retention) ? value.retention : {};
  const retention = {
    keepDaily: retentionInteger(retentionValue.keepDaily, 7, "retention.keepDaily"),
    keepWeekly: retentionInteger(retentionValue.keepWeekly, 4, "retention.keepWeekly"),
    keepMonthly: retentionInteger(retentionValue.keepMonthly, 12, "retention.keepMonthly"),
  };
  const repositoryId = value.repositoryId === undefined || value.repositoryId === null || value.repositoryId === ""
    ? null : requireId(value.repositoryId, "repositoryId");
  const destinationFolder = value.destinationFolder === undefined || value.destinationFolder === null || value.destinationFolder === ""
    ? null : safeName(value.destinationFolder, "destinationFolder");
  return { enabled, sourcePaths, excludePatterns, schedule, timezone, retention, repositoryId, destinationFolder };
}

function normalizeSchedule(value) {
  if (!isRecord(value)) throw new RangeError("schedule must be an object");
  if (value.kind !== "daily" && value.kind !== "weekly") throw new RangeError("schedule.kind must be daily or weekly");
  const time = requireString(value.time, "schedule.time", 5, 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError("schedule.time must be HH:MM");
  if (value.kind === "daily") return { kind: "daily", time };
  if (!Array.isArray(value.days) || value.days.length === 0) throw new RangeError("weekly schedules require days");
  const days = [...new Set(value.days)];
  if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new RangeError("schedule.days must contain 0-6");
  return { kind: "weekly", time, days };
}

function normalizeTimezone(value) {
  const timezone = requireString(value, "timezone", 1, 100);
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date()); }
  catch { throw new RangeError(`invalid timezone: ${timezone}`); }
  return timezone;
}

function normalizeProgress(value) {
  if (!isRecord(value)) throw new RangeError("progress must be an object");
  const phase = optionalString(value.phase, "progress.phase", 80) ?? "running";
  const percent = value.percent === undefined || value.percent === null ? null : boundedNumber(value.percent, 0, 100, "progress.percent");
  const bytesDone = optionalNonNegativeInteger(value.bytesDone, "progress.bytesDone");
  const bytesTotal = optionalNonNegativeInteger(value.bytesTotal, "progress.bytesTotal");
  const filesDone = optionalNonNegativeInteger(value.filesDone, "progress.filesDone");
  const filesTotal = optionalNonNegativeInteger(value.filesTotal, "progress.filesTotal");
  const directoriesDone = optionalNonNegativeInteger(value.directoriesDone, "progress.directoriesDone");
  const currentPath = optionalString(value.currentPath, "progress.currentPath", 1024);
  return { phase, percent, bytesDone, bytesTotal, filesDone, filesTotal, directoriesDone, currentPath };
}

function normalizeStatus(value) {
  if (!isRecord(value)) throw new RangeError("status must be an object");
  return {
    repositoryConfigured: requireBoolean(value.repositoryConfigured, "repositoryConfigured"),
    repositoryKind: optionalString(value.repositoryKind, "repositoryKind", 64),
    agentState: optionalString(value.agentState, "agentState", 64) ?? "idle",
    currentRunId: value.currentRunId ? requireId(value.currentRunId, "currentRunId") : null,
    lastBackupAt: optionalDateString(value.lastBackupAt, "lastBackupAt"),
    lastSuccessAt: optionalDateString(value.lastSuccessAt, "lastSuccessAt"),
    lastSnapshotId: optionalString(value.lastSnapshotId, "lastSnapshotId", 128),
    lastError: optionalString(value.lastError, "lastError", 4000),
    localDrives: normalizeReportedDrives(value.localDrives),
  };
}

function normalizeRecoveryOperation(value) {
  const operation = requireString(value, "operation", 1, 32);
  if (!RECOVERY_OPERATIONS.has(operation)) throw new RangeError("unsupported workstation recovery operation");
  return operation;
}
function normalizeStoredOperation(value) { return typeof value === "string" && value ? value : "backup"; }

function normalizeRecoveryRequest(operation, value) {
  if (!isRecord(value)) value = {};
  if (operation === "inventory" || operation === "check") return {};
  const snapshotId = normalizeSnapshotId(value.snapshotId);
  if (operation === "browse") return { snapshotId, path: normalizeSnapshotPath(value.path ?? "/", { required: true }) };
  const path = value.path === undefined || value.path === null || value.path === "" ? "" : normalizeSnapshotPath(value.path, { required: true });
  const result = { snapshotId, path };
  if (operation === "restore") result.previewRunId = requireId(value.previewRunId, "previewRunId");
  return result;
}

function normalizeResultState(value, operation) {
  if (value === "success" || value === "completed") return "completed";
  if (value === "partial" && operation === "backup") return "partial";
  if (value === "failure" || value === "failed") return "failed";
  throw new RangeError(operation === "backup" ? "status must be success, partial, or failure" : "recovery status must be success or failure");
}

function normalizeResult(value, operation, request, runId, state) {
  if (value === undefined || value === null) {
    if (operation === "backup" || state === "failed") return null;
    throw new RangeError("successful workstation operation must include a result");
  }
  if (!isRecord(value)) throw new RangeError("result must be an object");
  const max = operation === "backup" ? 64 * 1024 : operation === "source-scan" ? 15 * 1024 * 1024 : 900 * 1024;
  if (JSON.stringify(value).length > max) throw new RangeError("result is too large");
  if (operation === "backup") return value;
  if (value.operation !== operation) throw new RangeError("workstation result operation does not match the leased run");
  if (state === "failed" && (operation === "source-scan" || operation === "check" || operation === "inventory" || operation === "browse")) {
    return { operation };
  }
  if (operation === "source-scan") {
    const drives = normalizeSourceDrives(value.drives);
    if (JSON.stringify(drives) !== JSON.stringify(normalizeSourceDrives(request.drives))) throw new RangeError("source scan result does not match requested drives");
    if (!Array.isArray(value.nodes) || value.nodes.length > 75000) throw new RangeError("source scan result has too many directories");
    return { operation, drives, nodes: value.nodes.map(normalizeSourceScanNode), truncated: value.truncated === true };
  }
  if (operation === "check") {
    if (value.integrity !== "ok") throw new RangeError("integrity check result must report ok");
    return { operation, integrity: "ok" };
  }
  if (operation === "inventory") {
    if (!Array.isArray(value.snapshots) || value.snapshots.length > 250) throw new RangeError("inventory result is invalid");
    return { operation, snapshots: value.snapshots.map(normalizeSnapshotResult) };
  }
  if (operation === "browse") {
    if (normalizeSnapshotId(value.snapshotId) !== request.snapshotId || value.path !== request.path) throw new RangeError("browse result does not match the leased request");
    if (!Array.isArray(value.entries) || value.entries.length > 128) throw new RangeError("browse result has too many entries");
    const entryLimit = clampInteger(value.entryLimit, 1, 128, 128);
    return { operation, snapshotId: request.snapshotId, path: request.path, entries: value.entries.map(normalizeBrowseEntry), entryLimit, truncated: value.truncated === true };
  }
  if (operation === "restore-preview" || operation === "restore") {
    if (normalizeSnapshotId(value.snapshotId) !== request.snapshotId || (value.path ?? "") !== request.path) throw new RangeError("restore result does not match the leased request");
    if (value.stagingId !== runId) throw new RangeError("restore staging id does not match the leased run");
    const expectedDryRun = operation === "restore-preview";
    if (value.dryRun !== expectedDryRun) throw new RangeError("restore dry-run state does not match the leased operation");
    const logs = uniqueStrings(value.changedLogs ?? [], "changedLogs", 128, 2048);
    return {
      operation, snapshotId: request.snapshotId, path: request.path, stagingId: runId, dryRun: expectedDryRun,
      restored: optionalNonNegativeInteger(value.restored, "restored") ?? 0,
      updated: optionalNonNegativeInteger(value.updated, "updated") ?? 0,
      unchanged: optionalNonNegativeInteger(value.unchanged, "unchanged") ?? 0,
      changedLogs: logs, changedLogsTruncated: value.changedLogsTruncated === true,
    };
  }
  throw new RangeError("unsupported workstation result operation");
}

function normalizeSnapshotResult(value) {
  if (!isRecord(value)) throw new RangeError("snapshot result is invalid");
  const id = normalizeSnapshotId(value.id);
  const time = optionalDateString(value.time, "snapshot.time");
  if (!time) throw new RangeError("snapshot.time is required");
  return {
    id,
    shortId: optionalString(value.shortId, "snapshot.shortId", 64),
    time,
    hostname: optionalString(value.hostname, "snapshot.hostname", 128),
  };
}

function normalizeBrowseEntry(value) {
  if (!isRecord(value)) throw new RangeError("browse entry is invalid");
  return {
    path: normalizeSnapshotPath(value.path, { required: true }),
    name: requireRawString(value.name, "entry.name", 1, 1024),
    nodeType: requireRawString(value.nodeType, "entry.nodeType", 1, 32),
    size: optionalNonNegativeInteger(value.size, "entry.size") ?? 0,
    mtime: value.mtime ? requireRawString(value.mtime, "entry.mtime", 1, 64) : "",
    permissions: value.permissions ? requireRawString(value.permissions, "entry.permissions", 1, 32) : "",
  };
}

function normalizeSourceDrives(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 26) throw new RangeError("drives must contain 1-26 drive roots");
  const result=[];const seen=new Set();
  for (const item of value) {
    const drive=requireRawString(item,"drive",3,3).replace("/","\\").toUpperCase();
    if (!/^[A-Z]:\\$/.test(drive)) throw new RangeError("drives must be Windows drive roots such as C:\\");
    if (!seen.has(drive)) { seen.add(drive); result.push(drive); }
  }
  return result.sort();
}
function normalizeReportedDrives(value) {
  if (value === undefined || value === null) return [];
  return normalizeSourceDrives(value);
}
function normalizeSourceScanNode(value) {
  if (!isRecord(value)) throw new RangeError("source scan node is invalid");
  const path=requireRawString(value.path,"source path",3,1024);
  const parent=value.parent ? requireRawString(value.parent,"source parent",3,1024) : "";
  const name=requireRawString(value.name,"source name",1,255);
  return {
    path,parent,name,bytes:optionalNonNegativeInteger(value.bytes,"source bytes")??0,
    files:optionalNonNegativeInteger(value.files,"source files")??0,
    directories:optionalNonNegativeInteger(value.directories,"source directories")??0,
    inaccessible:value.inaccessible===true,
  };
}

function normalizeSnapshotId(value) {
  if (typeof value !== "string" || !SNAPSHOT_ID_RE.test(value.trim())) throw new RangeError("snapshotId must be 8-64 hexadecimal characters");
  return value.trim().toLowerCase();
}

function normalizeSnapshotPath(value, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new RangeError("snapshot path is required");
    return "";
  }
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/") || /[\r\n\x00]/.test(value)) throw new RangeError("snapshot path must be an absolute Restic path");
  if (value.split("/").some((part) => part === "." || part === "..")) throw new RangeError("snapshot path contains a dot segment");
  return value;
}

function policyFromRow(row) {
  return {
    deviceId: String(row.device_id), enabled: Number(row.enabled) === 1,
    sourcePaths: parseArray(row.source_paths_json), excludePatterns: parseArray(row.exclude_patterns_json),
    schedule: parseJson(row.schedule_json, { kind: "daily", time: "02:00" }), timezone: String(row.timezone),
    retention: parseJson(row.retention_json, { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 }),
    nextRunAt: nullableString(row.next_run_at), lastScheduledAt: nullableString(row.last_scheduled_at), lastRunId: nullableString(row.last_run_id),
  };
}

function presentWorkstation(row) {
  const lastSeenAt = nullableString(row.last_seen_at);
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  const online = Number(row.enabled) === 1 && Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs <= 3 * 60 * 1000;
  const policy = row.policy_enabled === null || row.policy_enabled === undefined ? null : {
    enabled: Number(row.policy_enabled) === 1, sourcePaths: parseArray(row.source_paths_json), excludePatterns: parseArray(row.exclude_patterns_json),
    schedule: parseJson(row.schedule_json, { kind: "daily", time: "02:00" }), timezone: String(row.timezone),
    retention: parseJson(row.retention_json, { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 }),
    nextRunAt: nullableString(row.next_run_at), lastScheduledAt: nullableString(row.last_scheduled_at),
    repositoryId: nullableString(row.repository_id), repositoryName: nullableString(row.repository_name),
    destinationFolder: nullableString(row.destination_folder), destinationPath: row.repository_path && row.destination_folder
      ? `/backup/${row.repository_path}/${row.destination_folder}` : null,
  };
  const lastRun = row.last_run_id ? {
    id: String(row.last_run_id), state: nullableString(row.last_run_state), queuedAt: nullableString(row.last_run_queued_at),
    startedAt: nullableString(row.last_run_started_at), finishedAt: nullableString(row.last_run_finished_at),
    progress: parseJson(row.last_run_progress_json, null), result: parseJson(row.last_run_result_json, null), error: nullableString(row.last_run_error),
  } : null;
  return {
    id: String(row.id), name: String(row.name), enabled: Number(row.enabled) === 1, version: nullableString(row.version),
    hostname: nullableString(row.hostname), platform: nullableString(row.platform), capabilities: parseArray(row.capabilities_json),
    firstSeenAt: nullableString(row.first_seen_at), lastSeenAt, online, policy,
    status: {
      repositoryConfigured: Number(row.repository_configured ?? 0) === 1, repositoryKind: nullableString(row.repository_kind),
      agentState: nullableString(row.agent_state), currentRunId: nullableString(row.current_run_id), lastBackupAt: nullableString(row.last_backup_at),
      lastSuccessAt: nullableString(row.last_success_at), lastSnapshotId: nullableString(row.last_snapshot_id),
      lastError: nullableString(row.status_error), localDrives: parseArray(row.local_drives_json), updatedAt: nullableString(row.status_updated_at),
    },
    lastRun,
  };
}

function presentRun(row, { includeLeaseToken = false } = {}) {
  if (!row) return null;
  const result = {
    id: String(row.id), deviceId: String(row.device_id), state: String(row.state), operation: normalizeStoredOperation(row.operation),
    request: parseJson(row.request_json, {}), scheduledFor: nullableString(row.scheduled_for),
    sourcePaths: parseArray(row.source_paths_json), excludePatterns: parseArray(row.exclude_patterns_json),
    retention: parseJson(row.retention_json, { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 }),
    queuedAt: String(row.queued_at), leasedAt: nullableString(row.leased_at), leaseExpiresAt: nullableString(row.lease_expires_at),
    startedAt: nullableString(row.started_at), finishedAt: nullableString(row.finished_at), progress: parseJson(row.progress_json, null),
    result: parseJson(row.result_json, null), error: nullableString(row.error_message), terminal: FINAL_STATES.has(String(row.state)), active: ACTIVE_STATES.has(String(row.state)),
  };
  if (includeLeaseToken) result.leaseToken = String(row.lease_token);
  return result;
}

function isOnline(lastSeenAt, at) { const ms = lastSeenAt ? Date.parse(lastSeenAt) : NaN; return Number.isFinite(ms) && at.getTime() - ms <= 3 * 60 * 1000; }
function uniqueStrings(value, name, maxItems, maxLength) { if (value === undefined || value === null) return []; if (!Array.isArray(value) || value.length > maxItems) throw new RangeError(`${name} may contain at most ${maxItems} values`); const result=[]; const seen=new Set(); for (const item of value) { const normalized=requireRawString(item,name,1,maxLength); if (!seen.has(normalized)) { seen.add(normalized); result.push(normalized); } } return result; }
function retentionInteger(value, fallback, name) { if (value === undefined) return fallback; if (!Number.isInteger(value) || value < 0 || value > 3650) throw new RangeError(`${name} must be 0-3650`); return value; }
function optionalNonNegativeInteger(value, name) { if (value === undefined || value === null) return null; if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`); return value; }
function boundedNumber(value, min, max, name) { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be ${min}-${max}`); return value; }
function optionalDateString(value, name) { if (value === undefined || value === null || value === "") return null; const text=requireString(value,name,1,64); if (!Number.isFinite(Date.parse(text))) throw new RangeError(`${name} must be an ISO date`); return new Date(text).toISOString(); }
function requireBoolean(value, name) { if (typeof value !== "boolean") throw new RangeError(`${name} must be boolean`); return value; }
function requireString(value, name, min, max) { if (typeof value !== "string") throw new RangeError(`${name} must be a string`); const result=value.trim(); if (result.length<min||result.length>max) throw new RangeError(`${name} must be ${min}-${max} characters`); return result; }
function requireRawString(value, name, min, max) { if (typeof value !== "string" || value.length < min || value.length > max || /[\r\n\x00]/.test(value)) throw new RangeError(`${name} must be ${min}-${max} valid characters`); return value; }
function optionalString(value, name, max) { if (value === undefined || value === null || value === "") return null; return requireString(value,name,1,max); }
function requireId(value, name) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.trim())) throw new RangeError(`${name} is invalid`); return value.trim(); }
function requireLeaseToken(value) { if (typeof value !== "string" || value.length < 24 || value.length > 256) throw statusError(401,"Invalid workstation lease token"); return value; }
function parseArray(value) { const parsed=parseJson(value,[]); return Array.isArray(parsed)?parsed.filter((item)=>typeof item==="string"):[]; }
function parseJson(value, fallback) { if (typeof value !== "string") return fallback; try { return JSON.parse(value); } catch { return fallback; } }
function nullableString(value) { return typeof value === "string" && value ? value : null; }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nowDate(now) { const value=now(); const date=value instanceof Date?new Date(value):new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date"); return date; }
function clampInteger(value, min, max, fallback) { const parsed=Number(value); return Number.isInteger(parsed)&&parsed>=min&&parsed<=max?parsed:fallback; }
function statusError(statusCode, message) { const error=new Error(message); error.statusCode=statusCode; return error; }
