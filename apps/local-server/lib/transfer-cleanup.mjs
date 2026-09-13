const TERMINAL_STATES = new Set(["completed", "partial", "failed", "cancelled", "interrupted"]);
const RETRYABLE_STATES = new Set(["partial", "failed", "interrupted"]);
const MODIFIED_PREFIX = "cleanup refused modified destination:";

export function createTransferCleanupService({ db, enqueueJob, now = () => new Date() }) {
  if (!db) throw new TypeError("db is required");
  if (typeof enqueueJob !== "function") throw new TypeError("enqueueJob is required");

  async function runDue({ limit = 50 } = {}) {
    const at = nowDate(now);
    const failures = [];
    const reconciled = await reconcile(at, failures);
    const queued = await queue(at, clampInteger(limit, 1, 200, 50), failures);
    return { reconciled, queued, failures };
  }

  async function reconcile(at, failures) {
    const rows = (await db.prepare(`
      SELECT o.rule_id,o.object_key,o.cleanup_job_id,o.cleanup_attempt_count,
             j.state AS job_state,j.finished_at,j.updated_at,j.last_error,
             r.retry_count,r.retry_wait_seconds
      FROM transfer_objects AS o
      JOIN backup_jobs AS j ON j.id=o.cleanup_job_id
      JOIN transfer_rules AS r ON r.id=o.rule_id
      WHERE o.state='done' AND o.cleanup_job_id IS NOT NULL
        AND j.state IN ('completed','partial','failed','cancelled','interrupted')
      ORDER BY j.updated_at ASC LIMIT 200
    `).all()).results ?? [];
    let changed = 0;
    for (const row of rows) {
      const ruleId = String(row.rule_id), objectKey = String(row.object_key), jobId = String(row.cleanup_job_id);
      try {
        const state = String(row.job_state);
        const finishedAt = validDate(row.finished_at ?? row.updated_at, at);
        if (state === "completed") {
          const result = await db.prepare(`
            UPDATE transfer_objects
            SET state='cleaned',cleanup_after=NULL,next_cleanup_retry_at=NULL,cleanup_job_id=NULL,last_error=NULL
            WHERE rule_id=? AND object_key=? AND state='done' AND cleanup_job_id=?
          `).bind(ruleId, objectKey, jobId).run();
          changed += Number(result.meta?.changes ?? 0);
          continue;
        }

        const message = typeof row.last_error === "string" && row.last_error ? row.last_error : `cleanup ${state}`;
        if (message.startsWith(MODIFIED_PREFIX)) {
          const result = await db.prepare(`
            UPDATE transfer_objects
            SET cleanup_after=NULL,next_cleanup_retry_at=NULL,cleanup_job_id=NULL,last_error=?
            WHERE rule_id=? AND object_key=? AND state='done' AND cleanup_job_id=?
          `).bind(message, ruleId, objectKey, jobId).run();
          changed += Number(result.meta?.changes ?? 0);
          continue;
        }

        const attempts = Number(row.cleanup_attempt_count);
        const retryLimit = Number(row.retry_count);
        if (RETRYABLE_STATES.has(state) && attempts <= retryLimit) {
          const retryAt = new Date(finishedAt.getTime() + Number(row.retry_wait_seconds) * 1000).toISOString();
          const result = await db.prepare(`
            UPDATE transfer_objects
            SET cleanup_job_id=NULL,next_cleanup_retry_at=?,last_error=?
            WHERE rule_id=? AND object_key=? AND state='done' AND cleanup_job_id=?
          `).bind(retryAt, message, ruleId, objectKey, jobId).run();
          changed += Number(result.meta?.changes ?? 0);
          continue;
        }

        const result = await db.prepare(`
          UPDATE transfer_objects
          SET cleanup_after=NULL,next_cleanup_retry_at=NULL,cleanup_job_id=NULL,last_error=?
          WHERE rule_id=? AND object_key=? AND state='done' AND cleanup_job_id=?
        `).bind(message, ruleId, objectKey, jobId).run();
        changed += Number(result.meta?.changes ?? 0);
      } catch (error) {
        failures.push({ ruleId, objectKey, phase: "cleanup-reconcile", message: errorMessage(error) });
      }
    }
    return changed;
  }

  async function queue(at, limit, failures) {
    const rows = (await db.prepare(`
      SELECT o.rule_id,o.object_key,o.rel_path,o.size,o.mod_time,o.cleanup_attempt_count,
             r.destination_endpoint_id,r.destination_path
      FROM transfer_objects AS o
      JOIN transfer_rules AS r ON r.id=o.rule_id
      WHERE r.enabled=1 AND r.cleanup_days>0 AND o.state='done'
        AND o.cleanup_after IS NOT NULL AND julianday(o.cleanup_after)<=julianday(?)
        AND o.cleanup_job_id IS NULL
        AND (o.next_cleanup_retry_at IS NULL OR julianday(o.next_cleanup_retry_at)<=julianday(?))
      ORDER BY o.cleanup_after ASC,o.first_seen_at ASC LIMIT ?
    `).bind(at.toISOString(), at.toISOString(), limit).all()).results ?? [];
    let queued = 0;
    for (const row of rows) {
      const ruleId = String(row.rule_id), objectKey = String(row.object_key);
      try {
        const attempt = Number(row.cleanup_attempt_count) + 1;
        const job = await enqueueJob({
          operationKey: `transfer-cleanup:${ruleId}:${objectKey}:attempt:${attempt}`,
          type: "managed-cleanup",
          payload: {
            ruleId,
            destinationEndpointId: String(row.destination_endpoint_id),
            destinationPath: String(row.destination_path),
            relPath: String(row.rel_path),
            expectedSize: Number(row.size),
            expectedModTime: String(row.mod_time),
            objectKey,
            cleanupAttempt: attempt,
          },
        });
        const result = await db.prepare(`
          UPDATE transfer_objects
          SET cleanup_job_id=?,cleanup_attempt_count=?,next_cleanup_retry_at=NULL,last_error=NULL
          WHERE rule_id=? AND object_key=? AND state='done' AND cleanup_job_id IS NULL
        `).bind(job.id, attempt, ruleId, objectKey).run();
        queued += Number(result.meta?.changes ?? 0);
      } catch (error) {
        failures.push({ ruleId, objectKey, phase: "cleanup-queue", message: errorMessage(error) });
      }
    }
    return queued;
  }

  return { runDue };
}

export function isPermanentCleanupRefusal(message) {
  return typeof message === "string" && message.startsWith(MODIFIED_PREFIX);
}
function nowDate(now){const value=now(),result=value instanceof Date?new Date(value):new Date(value);if(!Number.isFinite(result.getTime()))throw new TypeError("now() must return a valid date");return result}
function validDate(value,fallback){const result=new Date(value);return Number.isFinite(result.getTime())?result:new Date(fallback)}
function clampInteger(value,min,max,fallback){const number=Number(value);return Number.isInteger(number)?Math.min(max,Math.max(min,number)):fallback}
function errorMessage(error){return error instanceof Error?error.message:String(error)}
