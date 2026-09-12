import { randomUUID } from "node:crypto";

const PLAN_JOB_TYPES = new Set(["restic-backup", "rclone-restic-backup", "rclone-transfer"]);
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const TERMINAL_STATES = new Set(["completed", "partial", "failed", "cancelled", "interrupted"]);

export function createBackupPlanService({
  db,
  enqueueJob,
  loadAgentConfig,
  now = () => new Date(),
  id = () => randomUUID(),
}) {
  if (!db) throw new TypeError("db is required");
  if (typeof enqueueJob !== "function") throw new TypeError("enqueueJob is required");

  async function list() {
    const result = await db.prepare(`
      SELECT
        p.*,
        j.state AS last_job_state,
        j.started_at AS last_job_started_at,
        j.finished_at AS last_job_finished_at,
        j.updated_at AS last_job_updated_at,
        j.last_error AS last_job_error
      FROM backup_plans AS p
      LEFT JOIN backup_jobs AS j ON j.id = p.last_job_id
      ORDER BY p.name COLLATE NOCASE ASC, p.id ASC
    `).all();
    return (result.results ?? []).map(rowToPlan);
  }

  async function get(planId) {
    const row = await db.prepare(`
      SELECT
        p.*,
        j.state AS last_job_state,
        j.started_at AS last_job_started_at,
        j.finished_at AS last_job_finished_at,
        j.updated_at AS last_job_updated_at,
        j.last_error AS last_job_error
      FROM backup_plans AS p
      LEFT JOIN backup_jobs AS j ON j.id = p.last_job_id
      WHERE p.id = ?
    `).bind(planId).first();
    return row ? rowToPlan(row) : null;
  }

  async function create(input) {
    const at = nowDate(now);
    const plan = await normalizePlanInput(input, { loadAgentConfig });
    const planId = id();
    const nextRunAt = plan.enabled ? nextScheduleAt(plan.schedule, plan.timezone, at).toISOString() : null;
    await db.prepare(`
      INSERT INTO backup_plans (
        id, name, enabled, job_type, payload_json, schedule_json, timezone,
        retention_json, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      planId,
      plan.name,
      plan.enabled ? 1 : 0,
      plan.jobType,
      JSON.stringify(plan.payload),
      JSON.stringify(plan.schedule),
      plan.timezone,
      JSON.stringify(plan.retention),
      nextRunAt,
      at.toISOString(),
      at.toISOString(),
    ).run();
    return await get(planId);
  }

  async function update(planId, input) {
    const existing = await get(planId);
    if (!existing) throw notFound(planId);
    const at = nowDate(now);
    const plan = await normalizePlanInput(input, { loadAgentConfig });
    const nextRunAt = plan.enabled ? nextScheduleAt(plan.schedule, plan.timezone, at).toISOString() : null;
    await db.prepare(`
      UPDATE backup_plans
      SET name = ?, enabled = ?, job_type = ?, payload_json = ?, schedule_json = ?,
          timezone = ?, retention_json = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      plan.name,
      plan.enabled ? 1 : 0,
      plan.jobType,
      JSON.stringify(plan.payload),
      JSON.stringify(plan.schedule),
      plan.timezone,
      JSON.stringify(plan.retention),
      nextRunAt,
      at.toISOString(),
      planId,
    ).run();
    return await get(planId);
  }

  async function setEnabled(planId, enabled) {
    const existing = await get(planId);
    if (!existing) throw notFound(planId);
    if (typeof enabled !== "boolean") throw new RangeError("enabled must be a boolean");
    const at = nowDate(now);
    const nextRunAt = enabled ? nextScheduleAt(existing.schedule, existing.timezone, at).toISOString() : null;
    await db.prepare(`
      UPDATE backup_plans
      SET enabled = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(enabled ? 1 : 0, nextRunAt, at.toISOString(), planId).run();
    return await get(planId);
  }

  async function runNow(planId) {
    const plan = await get(planId);
    if (!plan) throw notFound(planId);
    const at = nowDate(now);
    const operationKey = `plan:${plan.id}:manual:${at.toISOString()}:${randomUUID()}`;
    const job = await enqueueJob({ operationKey, type: plan.jobType, payload: plan.payload });
    await db.prepare(`
      UPDATE backup_plans
      SET last_scheduled_at = ?, last_job_id = ?, updated_at = ?
      WHERE id = ?
    `).bind(at.toISOString(), job.id, at.toISOString(), plan.id).run();
    return { plan: await get(plan.id), job };
  }

  async function runDue({ limit = 20 } = {}) {
    const at = nowDate(now);
    const normalizedLimit = clampInteger(limit, 1, 100, 20);
    const result = await db.prepare(`
      SELECT * FROM backup_plans
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC, id ASC
      LIMIT ?
    `).bind(at.toISOString(), normalizedLimit).all();

    let enqueued = 0;
    const failures = [];
    for (const row of result.results ?? []) {
      const plan = rowToPlan(row);
      const scheduledFor = String(row.next_run_at);
      try {
        const job = await enqueueJob({
          operationKey: `plan:${plan.id}:${scheduledFor}`,
          type: plan.jobType,
          payload: plan.payload,
        });
        const nextRunAt = nextScheduleAt(plan.schedule, plan.timezone, at).toISOString();
        const updated = await db.prepare(`
          UPDATE backup_plans
          SET last_scheduled_at = ?, last_job_id = ?, next_run_at = ?, updated_at = ?
          WHERE id = ? AND enabled = 1 AND next_run_at = ?
        `).bind(
          scheduledFor,
          job.id,
          nextRunAt,
          at.toISOString(),
          plan.id,
          scheduledFor,
        ).run();
        if (Number(updated.meta?.changes ?? 0) > 0) enqueued += 1;
      } catch (error) {
        failures.push({
          planId: plan.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { enqueued, failures };
  }

  return { list, get, create, update, setEnabled, runNow, runDue };
}

export async function normalizePlanInput(value, { loadAgentConfig } = {}) {
  if (!isRecord(value)) throw new RangeError("plan must be an object");
  const name = requireString(value.name, "name", 1, 120);
  const enabled = value.enabled === undefined ? true : requireBoolean(value.enabled, "enabled");
  const jobType = requireEnum(value.jobType, PLAN_JOB_TYPES, "jobType");
  const payload = normalizePayload(jobType, value.payload);
  const schedule = normalizeSchedule(value.schedule);
  const timezone = normalizeTimezone(value.timezone ?? "UTC");
  const retention = normalizeRetention(value.retention, jobType);

  if (typeof loadAgentConfig === "function") {
    const config = await loadAgentConfig();
    validateTemplateAgainstConfig({ jobType, payload }, config);
  }

  return { name, enabled, jobType, payload, schedule, timezone, retention };
}

export function validateTemplateAgainstConfig(template, config) {
  if (!config?.available) throw new RangeError("agent config is unavailable");
  const sources = new Set((config.sources ?? []).map((item) => item.id));
  const repositories = new Set((config.repositories ?? []).map((item) => item.id));
  const endpoints = new Map((config.endpoints ?? []).map((item) => [item.id, item]));
  const { jobType, payload } = template;

  if (jobType === "restic-backup") {
    if (!sources.has(payload.sourceId)) throw new RangeError(`unknown sourceId: ${payload.sourceId}`);
    if (!repositories.has(payload.repositoryId)) throw new RangeError(`unknown repositoryId: ${payload.repositoryId}`);
    return;
  }
  if (jobType === "rclone-restic-backup") {
    const endpoint = endpoints.get(payload.sourceEndpointId);
    if (!endpoint) throw new RangeError(`unknown sourceEndpointId: ${payload.sourceEndpointId}`);
    if (!endpoint.mount?.enabled) throw new RangeError(`endpoint is not mountable: ${payload.sourceEndpointId}`);
    if (!repositories.has(payload.repositoryId)) throw new RangeError(`unknown repositoryId: ${payload.repositoryId}`);
    return;
  }
  if (jobType === "rclone-transfer") {
    if (!endpoints.has(payload.sourceEndpointId)) throw new RangeError(`unknown sourceEndpointId: ${payload.sourceEndpointId}`);
    if (!endpoints.has(payload.destinationEndpointId)) throw new RangeError(`unknown destinationEndpointId: ${payload.destinationEndpointId}`);
    if (payload.sourceEndpointId === payload.destinationEndpointId) {
      throw new RangeError("rclone source and destination must be different");
    }
  }
}

export function nextScheduleAt(scheduleValue, timezoneValue, afterValue) {
  const schedule = normalizeSchedule(scheduleValue);
  const timezone = normalizeTimezone(timezoneValue);
  const after = afterValue instanceof Date ? new Date(afterValue) : new Date(afterValue);
  if (!Number.isFinite(after.getTime())) throw new RangeError("after must be a valid date");

  const local = zonedParts(after, timezone);
  const [hour, minute] = schedule.time.split(":").map(Number);
  for (let offset = 0; offset <= 8; offset += 1) {
    const localDate = addCalendarDays(local.year, local.month, local.day, offset);
    if (schedule.kind === "weekly" && !schedule.days.includes(localDate.weekday)) continue;
    const candidate = resolveZonedLocal({
      year: localDate.year,
      month: localDate.month,
      day: localDate.day,
      hour,
      minute,
    }, timezone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error("Unable to calculate next backup schedule");
}

function normalizePayload(jobType, value) {
  if (!isRecord(value)) throw new RangeError("payload must be an object");
  if (jobType === "restic-backup") {
    return withOptionalTags({
      sourceId: requireString(value.sourceId, "sourceId", 1, 128),
      repositoryId: requireString(value.repositoryId, "repositoryId", 1, 128),
    }, value.tags);
  }
  if (jobType === "rclone-restic-backup") {
    return withOptionalTags({
      sourceEndpointId: requireString(value.sourceEndpointId, "sourceEndpointId", 1, 128),
      repositoryId: requireString(value.repositoryId, "repositoryId", 1, 128),
    }, value.tags);
  }
  const mode = value.mode === undefined ? "copy" : value.mode;
  if (mode !== "copy") throw new RangeError("scheduled rclone transfers only support copy mode");
  return {
    sourceEndpointId: requireString(value.sourceEndpointId, "sourceEndpointId", 1, 128),
    destinationEndpointId: requireString(value.destinationEndpointId, "destinationEndpointId", 1, 128),
    mode: "copy",
  };
}

function withOptionalTags(payload, value) {
  if (value === undefined || value === null) return payload;
  if (!Array.isArray(value)) throw new RangeError("tags must be an array");
  const tags = [...new Set(value.map((item) => requireString(item, "tag", 1, 100)))];
  if (tags.length > 20) throw new RangeError("tags may contain at most 20 values");
  return tags.length ? { ...payload, tags } : payload;
}

function normalizeSchedule(value) {
  if (!isRecord(value)) throw new RangeError("schedule must be an object");
  const kind = value.kind;
  if (kind !== "daily" && kind !== "weekly") throw new RangeError("schedule.kind must be daily or weekly");
  const time = requireString(value.time, "schedule.time", 5, 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError("schedule.time must be HH:MM");
  if (kind === "daily") return { kind, time };
  if (!Array.isArray(value.days) || value.days.length === 0) {
    throw new RangeError("weekly schedules require at least one day");
  }
  const unique = new Set();
  for (const day of value.days) {
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new RangeError("schedule.days must contain weekday numbers 0-6");
    unique.add(day);
  }
  const days = WEEKDAY_ORDER.filter((day) => unique.has(day));
  return { kind, time, days };
}

function normalizeRetention(value, jobType) {
  const defaults = jobType === "rclone-transfer"
    ? { keepDaily: 0, keepWeekly: 0, keepMonthly: 0 }
    : { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 };
  if (value === undefined || value === null) return defaults;
  if (!isRecord(value)) throw new RangeError("retention must be an object");
  return {
    keepDaily: retentionInteger(value.keepDaily, defaults.keepDaily, "retention.keepDaily"),
    keepWeekly: retentionInteger(value.keepWeekly, defaults.keepWeekly, "retention.keepWeekly"),
    keepMonthly: retentionInteger(value.keepMonthly, defaults.keepMonthly, "retention.keepMonthly"),
  };
}

function retentionInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 3650) throw new RangeError(`${name} must be an integer between 0 and 3650`);
  return value;
}

function normalizeTimezone(value) {
  const timezone = requireString(value, "timezone", 1, 100);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new RangeError(`invalid timezone: ${timezone}`);
  }
  return timezone;
}

function rowToPlan(row) {
  const payload = parseJson(row.payload_json, {});
  const schedule = parseJson(row.schedule_json, { kind: "daily", time: "03:00" });
  const retention = parseJson(row.retention_json, { keepDaily: 0, keepWeekly: 0, keepMonthly: 0 });
  const lastJobId = row.last_job_id === null || row.last_job_id === undefined ? null : String(row.last_job_id);
  const lastState = row.last_job_state === null || row.last_job_state === undefined ? null : String(row.last_job_state);
  return {
    id: String(row.id),
    name: String(row.name),
    enabled: Number(row.enabled) === 1,
    jobType: String(row.job_type),
    payload,
    schedule,
    timezone: String(row.timezone),
    retention,
    nextRunAt: row.next_run_at === null || row.next_run_at === undefined ? null : String(row.next_run_at),
    lastScheduledAt: row.last_scheduled_at === null || row.last_scheduled_at === undefined ? null : String(row.last_scheduled_at),
    lastJob: lastJobId ? {
      id: lastJobId,
      state: lastState,
      terminal: lastState ? TERMINAL_STATES.has(lastState) : false,
      startedAt: nullableString(row.last_job_started_at),
      finishedAt: nullableString(row.last_job_finished_at),
      updatedAt: nullableString(row.last_job_updated_at),
      error: nullableString(row.last_job_error),
    } : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function resolveZonedLocal(target, timezone) {
  for (let bump = 0; bump <= 120; bump += 1) {
    const shifted = new Date(Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute + bump));
    const desired = {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
    };
    const exact = resolveExactZonedLocal(desired, timezone);
    if (exact) return exact;
  }
  throw new Error(`Unable to resolve scheduled local time in ${timezone}`);
}

function resolveExactZonedLocal(target, timezone) {
  const targetMs = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, 0, 0);
  let guess = targetMs;
  for (let index = 0; index < 6; index += 1) {
    const parts = zonedParts(new Date(guess), timezone);
    const representedMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    const delta = targetMs - representedMs;
    if (delta === 0 && matchesTarget(parts, target)) return new Date(guess);
    guess += delta;
  }
  const parts = zonedParts(new Date(guess), timezone);
  return matchesTarget(parts, target) ? new Date(guess) : null;
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  return {
    year,
    month,
    day,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function addCalendarDays(year, month, day, offset) {
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function matchesTarget(parts, target) {
  return parts.year === target.year
    && parts.month === target.month
    && parts.day === target.day
    && parts.hour === target.hour
    && parts.minute === target.minute;
}

function nowDate(now) {
  const value = now();
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date");
  return date;
}

function notFound(planId) {
  const error = new Error(`Backup plan not found: ${planId}`);
  error.statusCode = 404;
  return error;
}

function parseJson(value, fallback) {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function nullableString(value) {
  return value === null || value === undefined ? null : String(value);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function requireString(value, name, min, max) {
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new RangeError(`${name} must be ${min}-${max} characters`);
  return normalized;
}

function requireBoolean(value, name) {
  if (typeof value !== "boolean") throw new RangeError(`${name} must be a boolean`);
  return value;
}

function requireEnum(value, allowed, name) {
  if (typeof value !== "string" || !allowed.has(value)) throw new RangeError(`${name} is invalid`);
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
