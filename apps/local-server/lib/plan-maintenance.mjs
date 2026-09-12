import { randomUUID } from "node:crypto";

const RESTIC_PLAN_TYPES = new Set(["restic-backup", "rclone-restic-backup"]);
const ACTIVE_STATES = new Set(["queued", "leased", "preparing", "running", "finalizing"]);

export function planSnapshotTag(planId) {
  return `nexus-plan:${requireId(planId, "planId")}`;
}

export function enrichPlanJob(input) {
  if (!input || typeof input !== "object") throw new TypeError("job input is required");
  if (!RESTIC_PLAN_TYPES.has(input.type)) return input;
  const planId = planIdFromOperationKey(input.operationKey);
  if (!planId) return input;
  const payload = isRecord(input.payload) ? input.payload : {};
  const internalTag = planSnapshotTag(planId);
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim())
    : [];
  return {
    ...input,
    payload: { ...payload, tags: [...new Set([...tags, internalTag])] },
  };
}

export function createPlanMaintenanceService({ db, enqueueJob, now = () => new Date() }) {
  if (!db) throw new TypeError("db is required");
  if (typeof enqueueJob !== "function") throw new TypeError("enqueueJob is required");

  async function list() {
    const result = await db.prepare(`
      SELECT
        p.id AS plan_id,
        p.name AS plan_name,
        p.job_type,
        p.payload_json,
        p.retention_json,
        p.last_job_id,
        p.last_maintenance_source_job_id,
        p.last_maintenance_job_id,
        b.state AS last_backup_state,
        b.finished_at AS last_backup_finished_at,
        m.state AS maintenance_state,
        m.updated_at AS maintenance_updated_at,
        m.finished_at AS maintenance_finished_at,
        m.last_error AS maintenance_error
      FROM backup_plans AS p
      LEFT JOIN backup_jobs AS b ON b.id = p.last_job_id
      LEFT JOIN backup_jobs AS m ON m.id = p.last_maintenance_job_id
      ORDER BY p.name COLLATE NOCASE ASC, p.id ASC
    `).all();
    return (result.results ?? []).map(rowToMaintenanceState);
  }

  async function runDue({ limit = 20 } = {}) {
    const at = nowDate(now);
    const normalizedLimit = clampInteger(limit, 1, 100, 20);
    const result = await db.prepare(`
      SELECT
        p.id AS plan_id,
        p.job_type,
        p.payload_json,
        p.retention_json,
        p.last_job_id,
        p.last_maintenance_source_job_id,
        b.state AS last_backup_state
      FROM backup_plans AS p
      JOIN backup_jobs AS b ON b.id = p.last_job_id
      WHERE p.job_type IN ('restic-backup', 'rclone-restic-backup')
        AND b.state = 'completed'
        AND p.last_job_id IS NOT NULL
        AND (p.last_maintenance_source_job_id IS NULL OR p.last_maintenance_source_job_id <> p.last_job_id)
      ORDER BY b.finished_at ASC, p.id ASC
      LIMIT ?
    `).bind(normalizedLimit).all();

    let enqueued = 0;
    const failures = [];
    for (const row of result.results ?? []) {
      const plan = maintenancePlanFromRow(row);
      try {
        if (!retentionEnabled(plan.retention)) {
          await markHandledWithoutJob(db, plan.id, plan.lastJobId, at);
          continue;
        }
        const job = await enqueueMaintenance(plan, {
          operationKey: `plan:${plan.id}:maintenance:${plan.lastJobId}`,
        });
        const updated = await db.prepare(`
          UPDATE backup_plans
          SET last_maintenance_source_job_id = ?, last_maintenance_job_id = ?, updated_at = ?
          WHERE id = ? AND last_job_id = ?
            AND (last_maintenance_source_job_id IS NULL OR last_maintenance_source_job_id <> last_job_id)
        `).bind(plan.lastJobId, job.id, at.toISOString(), plan.id, plan.lastJobId).run();
        if (Number(updated.meta?.changes ?? 0) > 0) enqueued += 1;
      } catch (error) {
        failures.push({ planId: plan.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { enqueued, failures };
  }

  async function runNow(planId) {
    const at = nowDate(now);
    const row = await db.prepare(`
      SELECT
        p.id AS plan_id,
        p.job_type,
        p.payload_json,
        p.retention_json,
        p.last_job_id,
        b.state AS last_backup_state,
        m.state AS maintenance_state
      FROM backup_plans AS p
      LEFT JOIN backup_jobs AS b ON b.id = p.last_job_id
      LEFT JOIN backup_jobs AS m ON m.id = p.last_maintenance_job_id
      WHERE p.id = ?
    `).bind(requireId(planId, "planId")).first();
    if (!row) throw statusError(404, `Backup plan not found: ${planId}`);
    const plan = maintenancePlanFromRow(row);
    if (!RESTIC_PLAN_TYPES.has(plan.jobType)) throw statusError(409, "Retention maintenance only applies to Restic backup plans");
    if (!retentionEnabled(plan.retention)) throw statusError(409, "Retention is disabled for this plan");
    if (!plan.lastJobId || plan.lastBackupState !== "completed") {
      throw statusError(409, "A completed plan backup is required before retention maintenance can run");
    }
    const maintenanceState = nullableString(row.maintenance_state);
    if (maintenanceState && ACTIVE_STATES.has(maintenanceState)) {
      throw statusError(409, "Retention maintenance is already active for this plan");
    }
    const job = await enqueueMaintenance(plan, {
      operationKey: `plan:${plan.id}:maintenance:manual:${at.toISOString()}:${randomUUID()}`,
    });
    await db.prepare(`
      UPDATE backup_plans
      SET last_maintenance_source_job_id = ?, last_maintenance_job_id = ?, updated_at = ?
      WHERE id = ?
    `).bind(plan.lastJobId, job.id, at.toISOString(), plan.id).run();
    return { job, maintenance: (await list()).find((item) => item.planId === plan.id) ?? null };
  }

  async function enqueueMaintenance(plan, { operationKey }) {
    return enqueueJob({
      operationKey,
      type: "restic-maintenance",
      payload: {
        repositoryId: plan.repositoryId,
        planTag: planSnapshotTag(plan.id),
        retention: plan.retention,
        sourceJobId: plan.lastJobId,
      },
    });
  }

  return { list, runDue, runNow };
}

function rowToMaintenanceState(row) {
  const plan = maintenancePlanFromRow(row);
  const maintenanceId = nullableString(row.last_maintenance_job_id);
  const maintenanceState = nullableString(row.maintenance_state);
  return {
    planId: plan.id,
    planName: nullableString(row.plan_name),
    applicable: RESTIC_PLAN_TYPES.has(plan.jobType),
    retentionEnabled: retentionEnabled(plan.retention),
    repositoryId: plan.repositoryId,
    planTag: RESTIC_PLAN_TYPES.has(plan.jobType) ? planSnapshotTag(plan.id) : null,
    lastBackup: plan.lastJobId ? {
      id: plan.lastJobId,
      state: plan.lastBackupState,
      finishedAt: nullableString(row.last_backup_finished_at),
    } : null,
    sourceJobHandled: nullableString(row.last_maintenance_source_job_id),
    maintenance: maintenanceId ? {
      id: maintenanceId,
      state: maintenanceState,
      active: maintenanceState ? ACTIVE_STATES.has(maintenanceState) : false,
      updatedAt: nullableString(row.maintenance_updated_at),
      finishedAt: nullableString(row.maintenance_finished_at),
      error: nullableString(row.maintenance_error),
    } : null,
  };
}

function maintenancePlanFromRow(row) {
  const payload = parseJson(row.payload_json, {});
  const retention = normalizeStoredRetention(parseJson(row.retention_json, {}));
  const jobType = String(row.job_type);
  const repositoryId = RESTIC_PLAN_TYPES.has(jobType) && typeof payload.repositoryId === "string"
    ? payload.repositoryId.trim()
    : null;
  if (RESTIC_PLAN_TYPES.has(jobType) && !repositoryId) throw new RangeError(`plan ${row.plan_id} is missing repositoryId`);
  return {
    id: String(row.plan_id),
    jobType,
    repositoryId,
    retention,
    lastJobId: nullableString(row.last_job_id),
    lastBackupState: nullableString(row.last_backup_state),
  };
}

function normalizeStoredRetention(value) {
  const record = isRecord(value) ? value : {};
  return {
    keepDaily: retentionInteger(record.keepDaily),
    keepWeekly: retentionInteger(record.keepWeekly),
    keepMonthly: retentionInteger(record.keepMonthly),
  };
}

function retentionInteger(value) {
  return Number.isInteger(value) && value >= 0 && value <= 3650 ? value : 0;
}

function retentionEnabled(retention) {
  return retention.keepDaily > 0 || retention.keepWeekly > 0 || retention.keepMonthly > 0;
}

async function markHandledWithoutJob(db, planId, sourceJobId, at) {
  await db.prepare(`
    UPDATE backup_plans
    SET last_maintenance_source_job_id = ?, last_maintenance_job_id = NULL, updated_at = ?
    WHERE id = ? AND last_job_id = ?
  `).bind(sourceJobId, at.toISOString(), planId, sourceJobId).run();
}

function planIdFromOperationKey(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^plan:([^:]+):/);
  return match?.[1] ?? null;
}

function requireId(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new RangeError(`${name} is invalid`);
  return value.trim();
}

function parseJson(value, fallback) {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function nullableString(value) {
  return value === null || value === undefined ? null : String(value);
}

function nowDate(now) {
  const value = now();
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date");
  return date;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
