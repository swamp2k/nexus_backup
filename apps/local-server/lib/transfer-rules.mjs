import { createHash, randomUUID } from "node:crypto";

const ACTIVE_STATES = new Set(["queued", "leased", "preparing", "running", "finalizing"]);
const FAILURE_STATES = new Set(["failed", "partial", "interrupted"]);
const TERMINAL_STATES = new Set(["completed", "partial", "failed", "cancelled", "interrupted"]);
const OBJECT_STATES = ["discovered", "ignored", "queued", "retry_wait", "done", "failed", "cancelled", "superseded", "cleaned"];
const MAX_DISCOVERY_OBJECTS = 5000;
const MAX_DISCOVERY_JSON = 700_000;

export function createTransferRuleService({ db, enqueueJob, loadAgentConfig, repositories = null, executeRepositoryTransfer = null, executeRepositoryDiscovery = null, now = () => new Date(), id = () => randomUUID() }) {
  if (!db) throw new TypeError("db is required");
  if (typeof enqueueJob !== "function") throw new TypeError("enqueueJob is required");

  async function list() {
    const rows = (await db.prepare(`
      SELECT r.*, j.state AS scan_job_state, j.updated_at AS scan_job_updated_at,
             j.finished_at AS scan_job_finished_at, j.last_error AS scan_job_error
      FROM transfer_rules AS r
      LEFT JOIN backup_jobs AS j ON j.id = r.last_scan_job_id
      ORDER BY r.name COLLATE NOCASE ASC, r.id ASC
    `).all()).results ?? [];
    const countRows = (await db.prepare(`
      SELECT rule_id, state, COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes
      FROM transfer_objects GROUP BY rule_id, state
    `).all()).results ?? [];
    const counts = new Map();
    for (const row of countRows) {
      const key = String(row.rule_id);
      if (!counts.has(key)) counts.set(key, {});
      counts.get(key)[String(row.state)] = { count: Number(row.count), bytes: Number(row.bytes) };
    }
    return rows.map((row) => rowToRule(row, counts.get(String(row.id)) ?? {}));
  }

  async function get(ruleId) {
    const normalized = requireId(ruleId, "ruleId");
    return (await list()).find((rule) => rule.id === normalized) ?? null;
  }

  async function objects(ruleId, { limit = 100 } = {}) {
    const normalized = requireId(ruleId, "ruleId");
    if (!await get(normalized)) throw notFound(normalized);
    const rows = (await db.prepare(`
      SELECT o.*, j.state AS job_state, j.updated_at AS job_updated_at, j.last_error AS job_error,
             p.bytes_done AS runtime_bytes_done, p.bytes_total AS runtime_bytes_total,
             p.speed_bytes_per_second AS runtime_speed, p.eta_seconds AS runtime_eta
      FROM transfer_objects AS o
      LEFT JOIN backup_jobs AS j ON j.id=o.last_job_id
      LEFT JOIN backup_job_runtime_progress AS p ON p.job_id=j.id AND p.attempt=j.attempt
      WHERE o.rule_id=?
      ORDER BY o.first_seen_at DESC, o.rel_path COLLATE NOCASE ASC
      LIMIT ?
    `).bind(normalized, clampInteger(limit, 1, 500, 100)).all()).results ?? [];
    return rows.map(objectRow);
  }

  async function create(input) {
    const at = nowDate(now);
    const value = await normalizeRuleInput(input, { loadAgentConfig, repositories });
    const ruleId = typeof input?.id === "string" && input.id.trim() ? requireId(input.id, "id") : id();
    await db.prepare(`
      INSERT INTO transfer_rules (
        id,name,enabled,source_endpoint_id,source_path,destination_endpoint_id,destination_path,destination_repository_id,
        mode,initial_behavior,stability_seconds,scan_interval_seconds,cleanup_days,verification,
        multi_thread_streams,multi_thread_cutoff,retry_count,retry_wait_seconds,rclone_args_json,
        includes_json,excludes_json,rtorrent_gate_id,next_scan_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      ruleId, value.name, value.enabled ? 1 : 0,
      value.sourceEndpointId, value.sourcePath, value.destinationEndpointId, value.destinationPath, value.destinationRepositoryId,
      value.mode, value.initialBehavior, value.stabilitySeconds, value.scanIntervalSeconds,
      value.cleanupDays, value.verification, value.multiThreadStreams, value.multiThreadCutoff,
      value.retryCount, value.retryWaitSeconds, JSON.stringify(value.rcloneArgs),
      JSON.stringify(value.includes), JSON.stringify(value.excludes), value.rtorrentGateId,
      value.enabled ? at.toISOString() : null, at.toISOString(), at.toISOString(),
    ).run();
    return get(ruleId);
  }

  async function update(ruleId, input) {
    const existing = await get(ruleId);
    if (!existing) throw notFound(ruleId);
    const at = nowDate(now);
    const value = await normalizeRuleInput(input, { loadAgentConfig, repositories });
    const structuralChange = value.sourceEndpointId !== existing.sourceEndpointId
      || value.sourcePath !== existing.sourcePath
      || value.destinationEndpointId !== existing.destinationEndpointId
      || value.destinationPath !== existing.destinationPath
      || value.destinationRepositoryId !== existing.destinationRepositoryId
      || value.mode !== existing.mode
      || value.initialBehavior !== existing.initialBehavior
      || value.rtorrentGateId !== existing.rtorrentGateId
      || JSON.stringify(value.includes) !== JSON.stringify(existing.includes)
      || JSON.stringify(value.excludes) !== JSON.stringify(existing.excludes);

    if (structuralChange) {
      if (existing.lastScanJob && ACTIVE_STATES.has(existing.lastScanJob.state)) throw statusError(409, "Transfer rule cannot change endpoints/filters/readiness gate during an active scan");
      if ((await activeManagedJobs(db, existing.id)).length > 0) throw statusError(409, "Transfer rule cannot change endpoints/filters/readiness gate while transfers are active");
    }

    await db.batch([
      db.prepare(`
        UPDATE transfer_rules SET
          name=?,enabled=?,source_endpoint_id=?,source_path=?,destination_endpoint_id=?,destination_path=?,destination_repository_id=?,
          mode=?,initial_behavior=?,stability_seconds=?,scan_interval_seconds=?,cleanup_days=?,verification=?,
          multi_thread_streams=?,multi_thread_cutoff=?,retry_count=?,retry_wait_seconds=?,rclone_args_json=?,
          includes_json=?,excludes_json=?,rtorrent_gate_id=?,next_scan_at=?,updated_at=?,revision=revision+1,
          initialized_at=CASE WHEN ? THEN NULL ELSE initialized_at END
        WHERE id=?
      `).bind(
        value.name, value.enabled ? 1 : 0,
        value.sourceEndpointId, value.sourcePath, value.destinationEndpointId, value.destinationPath, value.destinationRepositoryId,
        value.mode, value.initialBehavior, value.stabilitySeconds, value.scanIntervalSeconds,
        value.cleanupDays, value.verification, value.multiThreadStreams, value.multiThreadCutoff,
        value.retryCount, value.retryWaitSeconds, JSON.stringify(value.rcloneArgs),
        JSON.stringify(value.includes), JSON.stringify(value.excludes), value.rtorrentGateId,
        value.enabled ? at.toISOString() : null, at.toISOString(), structuralChange ? 1 : 0, existing.id,
      ),
      ...(structuralChange ? [db.prepare("DELETE FROM transfer_objects WHERE rule_id=?").bind(existing.id)] : []),
    ]);
    return get(existing.id);
  }

  async function setEnabled(ruleId, enabled) {
    if (typeof enabled !== "boolean") throw new RangeError("enabled must be a boolean");
    const existing = await get(ruleId);
    if (!existing) throw notFound(ruleId);
    const at = nowDate(now);
    await db.prepare(`UPDATE transfer_rules SET enabled=?,next_scan_at=?,updated_at=?,revision=revision+1 WHERE id=?`)
      .bind(enabled ? 1 : 0, enabled ? at.toISOString() : null, at.toISOString(), existing.id).run();
    return get(existing.id);
  }

  async function scanNow(ruleId) {
    const rule = await get(ruleId);
    if (!rule) throw notFound(ruleId);
    if (!rule.enabled) throw statusError(409, "Transfer rule is disabled");
    if (rule.lastScanJob && ACTIVE_STATES.has(rule.lastScanJob.state)) return { job: rule.lastScanJob, alreadyRunning: true };
    return { job: await queueDiscovery(rule, nowDate(now), true), alreadyRunning: false };
  }

  async function runDue({ scanLimit = 10, transferLimit = 50 } = {}) {
    const at = nowDate(now);
    const failures = [];
    await reconcileTerminalTransfers(at, failures);
    await reconcileFailedScans(at);
    const transfers = await queueReadyTransfers(at, clampInteger(transferLimit, 1, 200, 50), failures);
    const scans = await queueDueScans(at, clampInteger(scanLimit, 1, 50, 10), failures);
    return { scans, transfers, failures };
  }

  async function queueDiscovery(rule, at, manual) {
    const scheduled = rule.nextScanAt ?? at.toISOString();
    if (typeof executeRepositoryDiscovery === "function") {
      const result = await executeRepositoryDiscovery({
        ruleId: rule.id,
        sourceEndpointId: rule.sourceEndpointId,
        sourcePath: rule.sourcePath,
        includes: rule.includes,
        excludes: rule.excludes,
        ...(rule.rtorrentGateId ? { rtorrentGateId: rule.rtorrentGateId } : {}),
      });
      const nextScanAt = new Date(at.getTime() + rule.scanIntervalSeconds * 1000).toISOString();
      await db.prepare(`UPDATE transfer_rules SET last_scan_started_at=?,last_scan_job_id=?,next_scan_at=?,last_error=NULL,updated_at=? WHERE id=?`)
        .bind(at.toISOString(), result.job.id, nextScanAt, at.toISOString(), rule.id).run();
      return result.job;
    }
    const job = await enqueueJob({
      operationKey: manual ? `transfer-scan:${rule.id}:manual:${at.toISOString()}:${id()}` : `transfer-scan:${rule.id}:${scheduled}`,
      type: "rclone-discovery",
      payload: {
        ruleId: rule.id,
        sourceEndpointId: rule.sourceEndpointId,
        sourcePath: rule.sourcePath,
        includes: rule.includes,
        excludes: rule.excludes,
        ...(rule.rtorrentGateId ? { rtorrentGateId: rule.rtorrentGateId } : {}),
      },
    });
    const nextScanAt = new Date(at.getTime() + rule.scanIntervalSeconds * 1000).toISOString();
    await db.prepare(`UPDATE transfer_rules SET last_scan_started_at=?,last_scan_job_id=?,next_scan_at=?,last_error=NULL,updated_at=? WHERE id=?`)
      .bind(at.toISOString(), job.id, nextScanAt, at.toISOString(), rule.id).run();
    return job;
  }

  async function queueDueScans(at, limit, failures) {
    const rows = (await db.prepare(`
      SELECT id FROM transfer_rules
      WHERE enabled=1 AND next_scan_at IS NOT NULL AND julianday(next_scan_at)<=julianday(?)
      ORDER BY next_scan_at ASC,id ASC LIMIT ?
    `).bind(at.toISOString(), limit).all()).results ?? [];
    let enqueued = 0;
    for (const row of rows) {
      const ruleId = String(row.id);
      try {
        const rule = await get(ruleId);
        if (!rule || (rule.lastScanJob && ACTIVE_STATES.has(rule.lastScanJob.state))) continue;
        await queueDiscovery(rule, at, false);
        enqueued += 1;
      } catch (error) { failures.push({ ruleId, phase: "scan", message: errorMessage(error) }); }
    }
    return enqueued;
  }

  async function queueReadyTransfers(at, limit, failures) {
    const rows = (await db.prepare(`
      SELECT o.*,r.source_endpoint_id,r.source_path,r.destination_endpoint_id,r.destination_path,r.destination_repository_id,r.mode,
             r.verification,r.multi_thread_streams,r.multi_thread_cutoff,r.rclone_args_json,
             r.retry_count,r.retry_wait_seconds,r.cleanup_days,r.stability_seconds,r.last_scan_started_at
      FROM transfer_objects AS o
      JOIN transfer_rules AS r ON r.id=o.rule_id
      WHERE r.enabled=1 AND o.group_key IS NULL AND (
        (o.state='discovered'
          AND julianday(o.stable_since)<=julianday(?)-(CAST(r.stability_seconds AS REAL)/86400.0)
          AND (r.last_scan_started_at IS NULL OR julianday(o.last_seen_at)>=julianday(r.last_scan_started_at)))
        OR (o.state='retry_wait' AND o.next_retry_at IS NOT NULL AND julianday(o.next_retry_at)<=julianday(?))
      )
      ORDER BY o.first_seen_at ASC,o.rel_path COLLATE NOCASE ASC LIMIT ?
    `).bind(at.toISOString(), at.toISOString(), limit).all()).results ?? [];

    let enqueued = 0;
    for (const row of rows) {
      const ruleId = String(row.rule_id), objectKey = String(row.object_key);
      try {
        const attempt = Number(row.attempt_count) + 1;
        const payload = {
          ruleId,
          sourceEndpointId: String(row.source_endpoint_id), sourcePath: String(row.source_path),
          destinationEndpointId: String(row.destination_endpoint_id), destinationPath: String(row.destination_path),
          ...(row.destination_repository_id ? { destinationRepositoryId: String(row.destination_repository_id) } : {}),
          mode: String(row.mode), verification: String(row.verification), transferAttempt: attempt,
          multiThreadStreams: Number(row.multi_thread_streams), multiThreadCutoff: String(row.multi_thread_cutoff),
          rcloneArgs: parseJsonArray(row.rclone_args_json),
          items: [{ relPath: String(row.rel_path), size: Number(row.size), modTime: String(row.mod_time), objectKey }],
        };
        const jobResult = row.destination_repository_id && typeof executeRepositoryTransfer === "function"
          ? await executeRepositoryTransfer(payload)
          : { job: await enqueueJob({
          operationKey: `transfer:${ruleId}:${objectKey}:attempt:${attempt}`,
          type: "managed-transfer",
          payload,
        }) };
        const job = jobResult.job;
        const changed = await db.prepare(`
          UPDATE transfer_objects SET state='queued',last_job_id=?,attempt_count=?,next_retry_at=NULL,last_error=NULL
          WHERE rule_id=? AND object_key=? AND state IN ('discovered','retry_wait')
        `).bind(job.id, attempt, ruleId, objectKey).run();
        if (Number(changed.meta?.changes ?? 0) > 0) enqueued += 1;
      } catch (error) { failures.push({ ruleId, objectKey, phase: "transfer", message: errorMessage(error) }); }
    }
    return enqueued;
  }

  async function reconcileTerminalTransfers(at, failures) {
    const rows = (await db.prepare(`
      SELECT o.rule_id,o.object_key,o.attempt_count,j.id AS job_id,j.state AS job_state,
             j.finished_at,j.updated_at,j.last_error,r.retry_count,r.retry_wait_seconds,r.cleanup_days
      FROM transfer_objects AS o JOIN backup_jobs AS j ON j.id=o.last_job_id JOIN transfer_rules AS r ON r.id=o.rule_id
      WHERE o.state='queued' AND j.state IN ('completed','partial','failed','cancelled','interrupted')
      ORDER BY j.updated_at ASC LIMIT 200
    `).all()).results ?? [];
    for (const row of rows) {
      const ruleId = String(row.rule_id), objectKey = String(row.object_key);
      try {
        const finishedAt = validDate(row.finished_at ?? row.updated_at, at);
        if (row.job_state === "completed") {
          const cleanupAfter = Number(row.cleanup_days) > 0 ? new Date(finishedAt.getTime() + Number(row.cleanup_days) * 86400000).toISOString() : null;
          await db.prepare(`
            UPDATE transfer_objects SET state='done',committed_at=?,destination_rel_path=rel_path,cleanup_after=?,last_error=NULL,next_retry_at=NULL
            WHERE rule_id=? AND object_key=? AND state='queued' AND last_job_id=?
          `).bind(finishedAt.toISOString(), cleanupAfter, ruleId, objectKey, row.job_id).run();
          continue;
        }
        if (row.job_state === "cancelled") {
          await db.prepare(`UPDATE transfer_objects SET state='cancelled',next_retry_at=NULL,last_error=? WHERE rule_id=? AND object_key=? AND state='queued' AND last_job_id=?`)
            .bind(row.last_error ?? "transfer cancelled", ruleId, objectKey, row.job_id).run();
          continue;
        }
        if (FAILURE_STATES.has(String(row.job_state)) && Number(row.attempt_count) <= Number(row.retry_count)) {
          const retryAt = new Date(finishedAt.getTime() + Number(row.retry_wait_seconds) * 1000).toISOString();
          await db.prepare(`UPDATE transfer_objects SET state='retry_wait',next_retry_at=?,last_error=? WHERE rule_id=? AND object_key=? AND state='queued' AND last_job_id=?`)
            .bind(retryAt, row.last_error ?? `transfer ${row.job_state}`, ruleId, objectKey, row.job_id).run();
        } else {
          await db.prepare(`UPDATE transfer_objects SET state='failed',next_retry_at=NULL,last_error=? WHERE rule_id=? AND object_key=? AND state='queued' AND last_job_id=?`)
            .bind(row.last_error ?? `transfer ${row.job_state}`, ruleId, objectKey, row.job_id).run();
        }
      } catch (error) { failures.push({ ruleId, objectKey, phase: "reconcile", message: errorMessage(error) }); }
    }
  }

  async function reconcileFailedScans(at) {
    const rows = (await db.prepare(`
      SELECT r.id,r.last_scan_job_id,r.last_scan_completed_at,j.state,j.updated_at,j.finished_at,j.last_error
      FROM transfer_rules AS r JOIN backup_jobs AS j ON j.id=r.last_scan_job_id
      WHERE j.state IN ('partial','failed','cancelled','interrupted')
    `).all()).results ?? [];
    for (const row of rows) {
      const finishedAt = validDate(row.finished_at ?? row.updated_at, at).toISOString();
      if (row.last_scan_completed_at && Date.parse(String(row.last_scan_completed_at)) >= Date.parse(finishedAt)) continue;
      await db.prepare(`UPDATE transfer_rules SET last_scan_completed_at=?,last_error=?,updated_at=? WHERE id=? AND last_scan_job_id=?`)
        .bind(finishedAt, row.last_error ?? `scan ${row.state}`, at.toISOString(), row.id, row.last_scan_job_id).run();
    }
  }

  return { list, get, objects, create, update, setEnabled, scanNow, runDue };
}

export async function persistTransferDiscovery(db, { jobId, expectedRuleId, event, at = new Date() }) {
  const normalized = normalizeTransferDiscoveryEvent(event, { expectedRuleId, now: at });
  const rule = await db.prepare("SELECT * FROM transfer_rules WHERE id=?").bind(normalized.ruleId).first();
  if (!rule) throw new RangeError(`transfer discovery rule does not exist: ${normalized.ruleId}`);
  const firstScan = rule.initialized_at === null || rule.initialized_at === undefined;
  const initialState = firstScan && rule.initial_behavior === "ignore_existing" ? "ignored" : "discovered";
  const seenAt = normalized.at;
  const statements = [db.prepare("DELETE FROM transfer_discovery_entries WHERE job_id=?").bind(jobId)];
  for (const item of normalized.entries) {
    const key = objectKey(item.relPath, item.size, item.modTime);
    statements.push(db.prepare(`INSERT INTO transfer_discovery_entries(job_id,rule_id,object_key,rel_path,size,mod_time,seen_at) VALUES(?,?,?,?,?,?,?)`)
      .bind(jobId, normalized.ruleId, key, item.relPath, item.size, item.modTime, seenAt));
  }
  statements.push(db.prepare(`
    UPDATE transfer_objects SET state='superseded',next_retry_at=NULL
    WHERE rule_id=? AND state IN ('discovered','retry_wait') AND EXISTS (
      SELECT 1 FROM transfer_discovery_entries AS s
      WHERE s.job_id=? AND s.rule_id=transfer_objects.rule_id AND s.rel_path=transfer_objects.rel_path AND s.object_key<>transfer_objects.object_key
    )
  `).bind(normalized.ruleId, jobId));
  statements.push(db.prepare(`
    INSERT INTO transfer_objects(rule_id,object_key,rel_path,size,mod_time,first_seen_at,last_seen_at,stable_since,state)
    SELECT rule_id,object_key,rel_path,size,mod_time,seen_at,seen_at,seen_at,? FROM transfer_discovery_entries WHERE job_id=?
    ON CONFLICT(rule_id,object_key) DO UPDATE SET last_seen_at=excluded.last_seen_at
  `).bind(initialState, jobId));
  statements.push(db.prepare(`
    UPDATE transfer_rules SET initialized_at=COALESCE(initialized_at,?),last_scan_completed_at=?,last_error=NULL,updated_at=?
    WHERE id=? AND last_scan_job_id=?
  `).bind(seenAt, seenAt, seenAt, normalized.ruleId, jobId));
  statements.push(db.prepare("DELETE FROM transfer_discovery_entries WHERE job_id=?").bind(jobId));
  await db.batch(statements);
  return normalized;
}

export function normalizeTransferDiscoveryEvent(value, { expectedRuleId, now = new Date() } = {}) {
  if (!isRecord(value) || value.type !== "transfer-discovery" || value.tool !== "rclone") throw new RangeError("transfer discovery event must be a rclone transfer-discovery object");
  const ruleId = requireId(value.ruleId, "ruleId");
  if (ruleId !== expectedRuleId) throw new RangeError("transfer discovery ruleId does not match the job payload");
  if (!Array.isArray(value.entries)) throw new RangeError("transfer discovery entries must be an array");
  if (value.entries.length > MAX_DISCOVERY_OBJECTS) throw new RangeError(`transfer discovery may contain at most ${MAX_DISCOVERY_OBJECTS} files`);
  const entries = value.entries.map(normalizeDiscoveryEntry), seen = new Set();
  for (const entry of entries) { if (seen.has(entry.relPath)) throw new RangeError(`duplicate transfer discovery path: ${entry.relPath}`); seen.add(entry.relPath); }
  if (JSON.stringify(entries).length > MAX_DISCOVERY_JSON) throw new RangeError("transfer discovery payload is too large");
  return { type: "transfer-discovery", tool: "rclone", ruleId, at: normalizeAt(value.at, now), entries };
}

export async function normalizeRuleInput(value, { loadAgentConfig, repositories } = {}) {
  if (!isRecord(value)) throw new RangeError("transfer rule must be an object");
  const result = {
    name: requireString(value.name, "name", 1, 120),
    enabled: value.enabled === undefined ? true : requireBoolean(value.enabled, "enabled"),
    sourceEndpointId: requireId(value.sourceEndpointId, "sourceEndpointId"), sourcePath: normalizeRelativeBase(value.sourcePath ?? ""),
    destinationRepositoryId: value.destinationRepositoryId === undefined || value.destinationRepositoryId === null || value.destinationRepositoryId === "" ? null : requireId(value.destinationRepositoryId, "destinationRepositoryId"),
    destinationEndpointId: value.destinationRepositoryId ? requireId(value.destinationEndpointId ?? "repository", "destinationEndpointId") : requireId(value.destinationEndpointId, "destinationEndpointId"), destinationPath: normalizeRelativeBase(value.destinationPath ?? ""),
    mode: value.mode === undefined ? "copy" : requireEnum(value.mode, new Set(["copy", "move"]), "mode"),
    initialBehavior: value.initialBehavior === undefined ? "ignore_existing" : requireEnum(value.initialBehavior, new Set(["ignore_existing", "process_existing"]), "initialBehavior"),
    stabilitySeconds: integerRange(value.stabilitySeconds ?? 600, "stabilitySeconds", 0, 604800),
    scanIntervalSeconds: integerRange(value.scanIntervalSeconds ?? 300, "scanIntervalSeconds", 15, 86400),
    cleanupDays: integerRange(value.cleanupDays ?? 14, "cleanupDays", 0, 3650),
    verification: value.verification === undefined ? "size" : requireEnum(value.verification, new Set(["size"]), "verification"),
    multiThreadStreams: integerRange(value.multiThreadStreams ?? 4, "multiThreadStreams", 1, 32),
    multiThreadCutoff: requireString(value.multiThreadCutoff ?? "256M", "multiThreadCutoff", 1, 32),
    retryCount: integerRange(value.retryCount ?? 3, "retryCount", 0, 20), retryWaitSeconds: integerRange(value.retryWaitSeconds ?? 300, "retryWaitSeconds", 0, 86400),
    rcloneArgs: normalizeArgs(value.rcloneArgs), includes: normalizePatterns(value.includes), excludes: normalizePatterns(value.excludes),
    rtorrentGateId: value.rtorrentGateId === undefined || value.rtorrentGateId === null || value.rtorrentGateId === "" ? null : requireId(value.rtorrentGateId, "rtorrentGateId"),
  };
  if (result.destinationRepositoryId && !result.destinationPath) result.destinationPath = normalizeRelativeBase(result.name);
  if (repositories && result.destinationRepositoryId) {
    if (!await repositories.get(result.destinationRepositoryId)) throw new RangeError(`unknown destinationRepositoryId: ${result.destinationRepositoryId}`);
    result.destinationEndpointId = "repository";
  }
  if (result.sourceEndpointId === result.destinationEndpointId && result.sourcePath === result.destinationPath) throw new RangeError("transfer source and destination must be different");
  if (typeof loadAgentConfig === "function") {
    const config = await loadAgentConfig();
    if (!config?.available) throw new RangeError("agent config is unavailable");
    const endpoints = new Map((config.endpoints ?? []).map((item) => [item.id, item]));
    const gates = new Set((config.rtorrentGates ?? []).map((item) => item.id));
    const source = endpoints.get(result.sourceEndpointId), destination = result.destinationRepositoryId ? null : endpoints.get(result.destinationEndpointId);
    if (!source) throw new RangeError(`unknown sourceEndpointId: ${result.sourceEndpointId}`);
    if (!result.destinationRepositoryId && !destination) throw new RangeError(`unknown destinationEndpointId: ${result.destinationEndpointId}`);
    if (result.mode === "move" && source.allowMove !== true) throw new RangeError(`source endpoint does not allow move: ${result.sourceEndpointId}`);
    if (result.rtorrentGateId && !gates.has(result.rtorrentGateId)) throw new RangeError(`unknown rtorrentGateId: ${result.rtorrentGateId}`);
  }
  return result;
}

function normalizeDiscoveryEntry(value) { if (!isRecord(value)) throw new RangeError("transfer discovery entry must be an object"); return { relPath: normalizeObjectPath(value.relPath), size: integerRange(value.size, "entry.size", 0, Number.MAX_SAFE_INTEGER), modTime: requireDate(value.modTime, "entry.modTime") }; }
function objectKey(relPath, size, modTime) { return createHash("sha256").update(`${relPath}\0${size}\0${modTime}`).digest("hex"); }
function objectRow(row) { return { objectKey:String(row.object_key),path:String(row.rel_path),size:Number(row.size),modTime:String(row.mod_time),state:String(row.state),firstSeenAt:String(row.first_seen_at),lastSeenAt:String(row.last_seen_at),stableSince:String(row.stable_since),attemptCount:Number(row.attempt_count),nextRetryAt:nullableString(row.next_retry_at),committedAt:nullableString(row.committed_at),cleanupAfter:nullableString(row.cleanup_after),error:nullableString(row.last_error),job:row.last_job_id==null?null:{id:String(row.last_job_id),state:nullableString(row.job_state),updatedAt:nullableString(row.job_updated_at),error:nullableString(row.job_error),progress:row.runtime_bytes_done==null?null:{bytesDone:Number(row.runtime_bytes_done),bytesTotal:row.runtime_bytes_total==null?null:Number(row.runtime_bytes_total),speedBytesPerSecond:row.runtime_speed==null?null:Number(row.runtime_speed),etaSeconds:row.runtime_eta==null?null:Number(row.runtime_eta)}}}; }
function rowToRule(row, counts) { const scanJobId=nullableString(row.last_scan_job_id),scanState=nullableString(row.scan_job_state),normalizedCounts={};for(const state of OBJECT_STATES)normalizedCounts[state]=counts[state]??{count:0,bytes:0};return{id:String(row.id),name:String(row.name),enabled:Number(row.enabled)===1,sourceEndpointId:String(row.source_endpoint_id),sourcePath:String(row.source_path),destinationEndpointId:String(row.destination_endpoint_id),destinationPath:String(row.destination_path),destinationRepositoryId:nullableString(row.destination_repository_id),mode:String(row.mode),initialBehavior:String(row.initial_behavior),stabilitySeconds:Number(row.stability_seconds),scanIntervalSeconds:Number(row.scan_interval_seconds),cleanupDays:Number(row.cleanup_days),verification:String(row.verification),multiThreadStreams:Number(row.multi_thread_streams),multiThreadCutoff:String(row.multi_thread_cutoff),retryCount:Number(row.retry_count),retryWaitSeconds:Number(row.retry_wait_seconds),rcloneArgs:parseJsonArray(row.rclone_args_json),includes:parseJsonArray(row.includes_json),excludes:parseJsonArray(row.excludes_json),rtorrentGateId:nullableString(row.rtorrent_gate_id),initializedAt:nullableString(row.initialized_at),nextScanAt:nullableString(row.next_scan_at),lastScanStartedAt:nullableString(row.last_scan_started_at),lastScanCompletedAt:nullableString(row.last_scan_completed_at),lastError:nullableString(row.last_error),revision:Number(row.revision),counts:normalizedCounts,lastScanJob:scanJobId?{id:scanJobId,state:scanState,terminal:scanState?TERMINAL_STATES.has(scanState):false,updatedAt:nullableString(row.scan_job_updated_at),finishedAt:nullableString(row.scan_job_finished_at),error:nullableString(row.scan_job_error)}:null,createdAt:String(row.created_at),updatedAt:String(row.updated_at)}; }
async function activeManagedJobs(db,ruleId){const rows=(await db.prepare(`SELECT id,state,payload_json FROM backup_jobs WHERE type='managed-transfer' AND state IN ('queued','leased','preparing','running','finalizing') ORDER BY created_at`).all()).results??[];return rows.flatMap(row=>{try{return JSON.parse(String(row.payload_json))?.ruleId===ruleId?[{id:String(row.id),state:String(row.state)}]:[]}catch{return[]}})}
function normalizeObjectPath(value){const path=requireString(value,"entry.relPath",1,4096,false).replaceAll("\\","/").replace(/^\/+/,"").replace(/\/+$/,"");if(!path||path.split("/").some(part=>!part||part==="."||part===".."))throw new RangeError("entry.relPath must be a safe relative path");return path}
function normalizeRelativeBase(value){if(typeof value!=="string")throw new RangeError("path must be a string");const n=value.trim().replaceAll("\\","/").replace(/^\/+|\/+$/g,"");if(!n)return"";if(n.split("/").some(part=>!part||part==="."||part===".."))throw new RangeError("path may not contain dot segments");if(n.length>2048)throw new RangeError("path is too long");return n}
function normalizePatterns(value){if(value==null)return[];if(!Array.isArray(value))throw new RangeError("include/exclude patterns must be arrays");const r=[...new Set(value.map(item=>requireString(item,"pattern",1,512)))];if(r.length>50)throw new RangeError("include/exclude patterns may contain at most 50 values");return r}
function normalizeArgs(value){if(value==null)return[];if(!Array.isArray(value))throw new RangeError("rcloneArgs must be an array");const r=value.map(item=>requireString(item,"rclone argument",1,256));if(r.length>50)throw new RangeError("rcloneArgs may contain at most 50 values");return r}
function parseJsonArray(value){if(typeof value!=="string")return[];try{const p=JSON.parse(value);return Array.isArray(p)?p:[]}catch{return[]}}
function requireId(value,name){const r=requireString(value,name,1,128);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(r))throw new RangeError(`${name} contains unsupported characters`);return r}
function requireString(value,name,min,max,trim=true){if(typeof value!=="string")throw new RangeError(`${name} must be a string`);const r=trim?value.trim():value;if(r.length<min||r.length>max)throw new RangeError(`${name} must be ${min}-${max} characters`);return r}
function requireBoolean(value,name){if(typeof value!=="boolean")throw new RangeError(`${name} must be a boolean`);return value}
function requireEnum(value,allowed,name){if(typeof value!=="string"||!allowed.has(value))throw new RangeError(`${name} is invalid`);return value}
function integerRange(value,name,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError(`${name} must be an integer between ${min} and ${max}`);return value}
function requireDate(value,name){if(typeof value!=="string"||!Number.isFinite(Date.parse(value)))throw new RangeError(`${name} must be a valid date`);return new Date(value).toISOString()}
function normalizeAt(value,fallback){return typeof value==="string"&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():fallback.toISOString()}
function nowDate(now){const value=now(),result=value instanceof Date?new Date(value):new Date(value);if(!Number.isFinite(result.getTime()))throw new TypeError("now() must return a valid date");return result}
function validDate(value,fallback){const result=new Date(value);return Number.isFinite(result.getTime())?result:new Date(fallback)}
function clampInteger(value,min,max,fallback){const number=Number(value);return Number.isInteger(number)?Math.min(max,Math.max(min,number)):fallback}
function nullableString(value){return value==null?null:String(value)}
function statusError(statusCode,message){const error=new Error(message);error.statusCode=statusCode;return error}
function notFound(id){return statusError(404,`Transfer rule not found: ${id}`)}
function errorMessage(error){return error instanceof Error?error.message:String(error)}
function isRecord(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)}
