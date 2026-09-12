import { createHash } from "node:crypto";

const MAX_GROUPS = 1000;
const MAX_GROUP_PATHS = 5000;
const MAX_GROUP_JSON = 350_000;

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
        if (!members.every((member) => memberReady(member, at))) continue;

        const attempt = Math.max(...members.map((member) => Number(member.attempt_count))) + 1;
        const groupName = firstNonEmpty(members.map((member) => member.group_name)) ?? "torrent";
        const groupRoot = firstNonEmpty(members.map((member) => member.group_root)) ?? "";
        if (!groupRoot) throw new Error("torrent group is missing its relative root");
        if (members.some((member) => String(member.group_root ?? "") !== groupRoot)) {
          throw new Error("torrent group resolved to multiple relative roots");
        }

        const objectKeys = members.map((member) => String(member.object_key)).sort();
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
            items: members.map((member) => ({
              relPath: String(member.rel_path),
              size: Number(member.size),
              modTime: String(member.mod_time),
              objectKey: String(member.object_key),
            })),
          },
        });

        await db.batch(members.map((member) => db.prepare(`
          UPDATE transfer_objects
          SET state='queued', last_job_id=?, attempt_count=?, next_retry_at=NULL, last_error=NULL
          WHERE rule_id=? AND object_key=? AND group_kind='torrent' AND group_key=? AND state IN ('discovered','retry_wait')
        `).bind(job.id, attempt, ruleId, member.object_key, groupKey)));
        queued += 1;
      } catch (error) {
        failures.push({ ruleId, groupKey, phase: "torrent-group", message: errorMessage(error) });
      }
    }
    return { queued, failures };
  }

  return { runDue };
}

export async function persistTransferGroups(db, { expectedRuleId, event, at = new Date() }) {
  const normalized = normalizeTransferGroupsEvent(event, { expectedRuleId, now: at });
  const statements = [
    db.prepare(`
      UPDATE transfer_objects
      SET group_kind=NULL, group_key=NULL, group_name=NULL, group_root=NULL
      WHERE rule_id=? AND last_seen_at=?
    `).bind(normalized.ruleId, normalized.at),
  ];
  for (const group of normalized.groups) {
    for (const path of group.paths) {
      statements.push(db.prepare(`
        UPDATE transfer_objects
        SET group_kind='torrent', group_key=?, group_name=?, group_root=?
        WHERE rule_id=? AND rel_path=? AND last_seen_at=?
      `).bind(group.key, group.name, group.root, normalized.ruleId, path, normalized.at));
    }
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
  let pathCount = 0;
  const seenPaths = new Set();
  const groups = value.groups.map((raw) => {
    if (!isRecord(raw) || raw.kind !== "torrent") throw new RangeError("transfer group kind must be torrent");
    const key = requireTorrentKey(raw.key);
    const name = requireString(raw.name, "group name", 1, 240);
    const root = normalizeObjectPath(raw.root, "group root");
    if (!Array.isArray(raw.paths) || raw.paths.length === 0) throw new RangeError("transfer group paths must be a non-empty array");
    const paths = raw.paths.map((path) => normalizeObjectPath(path, "group path"));
    for (const path of paths) {
      pathCount += 1;
      if (pathCount > MAX_GROUP_PATHS) throw new RangeError(`transfer groups may reference at most ${MAX_GROUP_PATHS} paths`);
      if (!pathWithinRoot(path, root)) throw new RangeError(`transfer group path is outside its root: ${path}`);
      if (seenPaths.has(path)) throw new RangeError(`transfer group path appears more than once: ${path}`);
      seenPaths.add(path);
    }
    return { kind: "torrent", key, name, root, paths };
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
function firstNonEmpty(values) {
  for (const value of values) if (typeof value === "string" && value) return value;
  return null;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function parseJsonArray(value) { if (typeof value !== "string") return []; try { const parsed=JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function requireTorrentKey(value) {
  if (typeof value !== "string" || !/^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/.test(value.trim())) {
    throw new RangeError("torrent group key must be a 40- or 64-character hexadecimal info hash");
  }
  return value.trim().toLowerCase();
}
function requireId(value, name) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.trim())) throw new RangeError(`${name} is invalid`); return value.trim(); }
function requireString(value, name, min, max) { if (typeof value !== "string") throw new RangeError(`${name} must be a string`); const result=value.trim(); if (result.length<min||result.length>max) throw new RangeError(`${name} must be ${min}-${max} characters`); return result; }
function normalizeObjectPath(value, name) { if (typeof value !== "string") throw new RangeError(`${name} must be a string`); const path=value.replaceAll("\\","/").replace(/^\/+|\/+$/g,""); if (!path || path.split("/").some((part)=>!part||part==="."||part==="..")) throw new RangeError(`${name} must be a safe relative path`); return path; }
function pathWithinRoot(path, root) { return path === root || path.startsWith(`${root}/`); }
function normalizeAt(value, fallback) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fallback.toISOString(); return new Date(value).toISOString(); }
function clampInteger(value, min, max, fallback) { const number=Number(value); return Number.isInteger(number) ? Math.min(max,Math.max(min,number)) : fallback; }
function nowDate(now) { const value=now(), result=value instanceof Date ? new Date(value) : new Date(value); if (!Number.isFinite(result.getTime())) throw new TypeError("now() must return a valid date"); return result; }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
