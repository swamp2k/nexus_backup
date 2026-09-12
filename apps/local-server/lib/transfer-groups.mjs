import { createHash } from "node:crypto";

const MAX_GROUPS = 1000;
const MAX_GROUP_JSON = 180_000;
const GROUP_HOLD_AT = "9999-12-31T23:59:59.999Z";
const PASSIVE_STATES = new Set(["ignored", "done", "cleaned"]);
const BLOCKING_STATES = new Set(["queued", "failed", "cancelled"]);

export function createTransferGroupService({ db, enqueueJob, now = () => new Date() }) {
  if (!db) throw new TypeError("db is required");
  if (typeof enqueueJob !== "function") throw new TypeError("enqueueJob is required");

  async function runDue({ limit = 20 } = {}) {
    const at = nowDate(now);
    const rows = (await db.prepare(`
      SELECT
        o.rule_id,
        o.group_key,
        MIN(o.first_seen_at) AS first_seen_at,
        r.source_endpoint_id,
        r.source_path,
        r.destination_endpoint_id,
        r.destination_path,
        r.mode,
        r.verification,
        r.multi_thread_streams,
        r.multi_thread_cutoff,
        r.rclone_args_json,
        r.retry_wait_seconds,
        r.last_scan_started_at
      FROM transfer_objects AS o
      JOIN transfer_rules AS r ON r.id = o.rule_id
      WHERE r.enabled = 1
        AND r.mode = 'copy'
        AND o.group_kind = 'torrent'
        AND o.group_key IS NOT NULL
        AND (r.last_scan_started_at IS NULL OR julianday(o.last_seen_at) >= julianday(r.last_scan_started_at))
        AND (
          o.state = 'discovered'
          OR (o.state = 'retry_wait' AND o.next_retry_at IS NOT NULL AND julianday(o.next_retry_at) <= julianday(?))
        )
      GROUP BY o.rule_id, o.group_key
      ORDER BY first_seen_at ASC, o.rule_id ASC, o.group_key ASC
      LIMIT ?
    `).bind(at.toISOString(), clampInteger(limit, 1, 100, 20)).all()).results ?? [];

    let queued = 0;
    const failures = [];
    for (const row of rows) {
      const ruleId = String(row.rule_id);
      const groupKey = String(row.group_key);
      let pending = [];
      try {
        const members = (await db.prepare(`
          SELECT object_key, rel_path, size, mod_time, state, attempt_count, next_retry_at,
                 group_name, group_root, last_seen_at
          FROM transfer_objects
          WHERE rule_id = ?
            AND group_kind = 'torrent'
            AND group_key = ?
            AND (? IS NULL OR julianday(last_seen_at) >= julianday(?))
          ORDER BY rel_path COLLATE NOCASE ASC, object_key ASC
        `).bind(ruleId, groupKey, row.last_scan_started_at, row.last_scan_started_at).all()).results ?? [];
        if (members.length === 0) continue;
        if (members.some((member) => BLOCKING_STATES.has(String(member.state)))) continue;
        if (members.some((member) => !PASSIVE_STATES.has(String(member.state)) && !memberReady(member, at))) continue;
        pending = members.filter((member) => String(member.state) === "discovered" || String(member.state) === "retry_wait");
        if (pending.length === 0) continue;

        const attempt = Math.max(...pending.map((member) => Number(member.attempt_count))) + 1;
        const groupName = firstNonEmpty(members.map((member) => member.group_name)) ?? "torrent";
        const groupRoot = firstNonEmpty(members.map((member) => member.group_root)) ?? "";
        if (!groupRoot) throw new Error("torrent group is missing its relative root");
        if (members.some((member) => String(member.group_root ?? "") !== groupRoot)) {
          throw new Error("torrent group resolved to multiple relative roots");
        }

        const objectKeys = pending.map((member) => String(member.object_key)).sort();
        const manifestFingerprint = sha256(objectKeys.join("\n"));
        const groupFingerprint = sha256(groupKey);
        const job = await enqueueJob({
          operationKey: `transfer-group:${ruleId}:${groupFingerprint}:${manifestFingerprint}:attempt:${attempt}`,
          type: "managed-transfer",
          payload: {
            ruleId,
            sourceEndpointId: String(row.source_endpoint_id),
            sourcePath: String(row.source_path),
            destinationEndpointId: String(row.destination_endpoint_id),
            destinationPath: String(row.destination_path),
            mode: "copy",
            verification: String(row.verification),
            transferAttempt: attempt,
            multiThreadStreams: Number(row.multi_thread_streams),
            multiThreadCutoff: String(row.multi_thread_cutoff),
            rcloneArgs: parseJsonArray(row.rclone_args_json),
            group: { kind: "torrent", key: groupKey, name: groupName, root: groupRoot },
            items: pending.map((member) => ({
              relPath: String(member.rel_path),
              size: Number(member.size),
              modTime: String(member.mod_time),
              objectKey: String(member.object_key),
            })),
          },
        });

        await db.batch(pending.map((member) => db.prepare(`
          UPDATE transfer_objects
          SET state='queued', last_job_id=?, attempt_count=?, next_retry_at=NULL, last_error=NULL
          WHERE rule_id=? AND object_key=? AND group_kind='torrent' AND group_key=? AND state IN ('discovered','retry_wait')
        `).bind(job.id, attempt, ruleId, member.object_key, groupKey)));
        queued += 1;
      } catch (error) {
        if (pending.some((member) => String(member.state) === "retry_wait")) {
          const delaySeconds = Math.max(15, Number(row.retry_wait_seconds) || 0);
          const retryAt = new Date(at.getTime() + delaySeconds * 1000).toISOString();
          await db.prepare(`
            UPDATE transfer_objects
            SET next_retry_at=?
            WHERE rule_id=? AND group_kind='torrent' AND group_key=? AND state='retry_wait'
          `).bind(retryAt, ruleId, groupKey).run();
        }
        failures.push({ ruleId, groupKey, phase: "torrent-group", message: errorMessage(error) });
      }
    }
    return { queued, failures };
  }

  return { runDue };
}

export async function persistTransferGroups(db, { jobId, expectedRuleId, event, at = new Date() }) {
  const normalized = normalizeTransferGroupsEvent(event, { expectedRuleId, now: at });
  const rule = await db.prepare(`
    SELECT mode, last_scan_job_id, last_scan_completed_at
    FROM transfer_rules WHERE id=?
  `).bind(normalized.ruleId).first();
  if (!rule) throw new RangeError(`transfer group rule does not exist: ${normalized.ruleId}`);
  if (String(rule.last_scan_job_id ?? "") !== String(jobId ?? "")) {
    throw new RangeError("transfer groups do not belong to the rule's current scan job");
  }
  if (typeof rule.last_scan_completed_at !== "string" || !Number.isFinite(Date.parse(rule.last_scan_completed_at))) {
    throw new RangeError("transfer groups require a persisted discovery scan first");
  }
  const scanAt = new Date(rule.last_scan_completed_at).toISOString();
  const holdForGroup = String(rule.mode) === "copy";
  const statements = [
    db.prepare(`
      UPDATE transfer_objects
      SET stable_since=CASE WHEN group_key IS NOT NULL THEN last_seen_at ELSE stable_since END,
          group_kind=NULL, group_key=NULL, group_name=NULL, group_root=NULL
      WHERE rule_id=? AND last_seen_at=?
    `).bind(normalized.ruleId, scanAt),
  ];
  for (const group of normalized.groups) {
    statements.push(db.prepare(`
      UPDATE transfer_objects
      SET group_kind='torrent', group_key=?, group_name=?, group_root=?,
          stable_since=CASE WHEN ?=1 THEN ? ELSE stable_since END
      WHERE rule_id=? AND last_seen_at=?
        AND (rel_path=? OR substr(rel_path,1,length(?)+1)=?||'/')
    `).bind(
      group.key, group.name, group.root,
      holdForGroup ? 1 : 0, GROUP_HOLD_AT,
      normalized.ruleId, scanAt,
      group.root, group.root, group.root,
    ));
  }
  await db.batch(statements);
  return normalized;
}

export function normalizeTransferGroupsEvent(value, { expectedRuleId, now = new Date() } = {}) {
  if (!isRecord(value) || value.type !== "transfer-groups" || value.tool !== "rclone") {
    throw new RangeError("transfer groups event must be a rclone transfer-groups object");
  }
  const ruleId = requireId(value.ruleId, "ruleId");
  if (ruleId !== expectedRuleId) throw new RangeError("transfer groups ruleId does not match the job payload");
  if (!Array.isArray(value.groups) || value.groups.length > MAX_GROUPS) {
    throw new RangeError(`transfer groups may contain at most ${MAX_GROUPS} groups`);
  }
  const seenKeys = new Set();
  const seenRoots = new Set();
  const groups = value.groups.map((raw) => {
    if (!isRecord(raw) || raw.kind !== "torrent") throw new RangeError("transfer group kind must be torrent");
    const key = requireTorrentKey(raw.key);
    const name = requireString(raw.name, "group name", 1, 240);
    const root = normalizeObjectPath(raw.root, "group root");
    if (seenKeys.has(key)) throw new RangeError(`duplicate torrent group key: ${key}`);
    if (seenRoots.has(root)) throw new RangeError(`duplicate torrent group root: ${root}`);
    seenKeys.add(key);
    seenRoots.add(root);
    return { kind: "torrent", key, name, root };
  });
  if (JSON.stringify(groups).length > MAX_GROUP_JSON) throw new RangeError("transfer groups payload is too large");
  return { type: "transfer-groups", tool: "rclone", ruleId, at: normalizeAt(value.at, now), groups };
}

function memberReady(member, at) {
  const state = String(member.state);
  if (state === "discovered") return true;
  if (state !== "retry_wait" || typeof member.next_retry_at !== "string") return false;
  const retryAt = Date.parse(member.next_retry_at);
  return Number.isFinite(retryAt) && retryAt <= at.getTime();
}
function firstNonEmpty(values) { for (const value of values) if (typeof value === "string" && value) return value; return null; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function parseJsonArray(value) { if (typeof value !== "string") return []; try { const parsed=JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function requireTorrentKey(value) { if (typeof value !== "string" || !/^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/.test(value.trim())) throw new RangeError("torrent group key must be a 40- or 64-character hexadecimal info hash"); return value.trim().toLowerCase(); }
function requireId(value, name) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.trim())) throw new RangeError(`${name} is invalid`); return value.trim(); }
function requireString(value, name, min, max) { if (typeof value !== "string") throw new RangeError(`${name} must be a string`); const result=value.trim(); if (result.length<min||result.length>max) throw new RangeError(`${name} must be ${min}-${max} characters`); return result; }
function normalizeObjectPath(value, name) { if (typeof value !== "string") throw new RangeError(`${name} must be a string`); const path=value.replaceAll("\\","/").replace(/^\/+|\/+$/g,""); if (!path || path.split("/").some((part)=>!part||part==="."||part==="..")) throw new RangeError(`${name} must be a safe relative path`); return path; }
function normalizeAt(value, fallback) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fallback.toISOString(); return new Date(value).toISOString(); }
function clampInteger(value, min, max, fallback) { const number=Number(value); return Number.isInteger(number) ? Math.min(max,Math.max(min,number)) : fallback; }
function nowDate(now) { const value=now(), result=value instanceof Date ? new Date(value) : new Date(value); if (!Number.isFinite(result.getTime())) throw new TypeError("now() must return a valid date"); return result; }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
