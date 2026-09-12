# Transfer rules

Nexus Backup's M5 transfer engine ports the proven behavior of Copyarr into the existing Nexus job engine. It is not a second daemon with a separate queue: discovery and transfer work are normal leased Nexus jobs, while rule/object state is stored in the local SQLite database.

## Rule model

A transfer rule describes:

- source rclone endpoint plus optional relative source path
- destination endpoint plus optional relative destination path
- copy or verified move mode
- first-scan behavior: `ignore_existing` or `process_existing`
- scan interval and stability window
- bounded retry count and retry wait
- include/exclude patterns
- exact-size verification
- Copyarr-style multi-thread streams/cutoff
- optional per-rule rclone tuning arguments
- cleanup-days policy for a later maintenance slice

Endpoints are referenced only by configured IDs. The control plane never receives rclone credentials.

## Object identity and discovery

Discovery runs `rclone lsjson --recursive --files-only` against the configured source. The agent emits one bounded `transfer-discovery` telemetry event for the leased discovery job.

An object generation is identified by SHA-256 over:

```text
relative path + NUL + byte size + NUL + normalized modification time
```

This deliberately follows Copyarr's path + size + mtime identity. A file changed in place becomes a new generation instead of resurrecting an old completed/ignored object.

The first successful scan initializes the rule. With `ignore_existing`, generations seen in that first scan are persisted as ignored; future generations start as discovered. With `process_existing`, first-scan generations are eligible for the normal stability gate.

A discovered object is eligible only if it was also seen in the latest scan and its `stable_since` age meets the rule's stability window. This prevents a stale database row from being queued after the source object disappeared.

## Filter semantics

Filtering intentionally matches Copyarr:

1. if an include pattern matches, the path is allowed immediately;
2. otherwise, if an exclude pattern matches, it is rejected;
3. otherwise, it is allowed.

Therefore include patterns are rescue rules, not an implicit whitelist. A filename-only pattern such as `*.mkv` matches at any directory depth.

## Transfer safety sequence

Managed transfer jobs execute this sequence for each manifest item:

```text
source
  -> unique .nexus-backup-staging/<job-id>/... path
  -> exact byte-size verification
  -> moveto final destination
  -> exact byte-size verification
  -> optional exact source-file delete for move mode
```

Source deletion is impossible until final verification has succeeded. Move mode also requires the source endpoint to contain local `allowMove: true` configuration. Nexus deletes only the committed source file; it does not purge a broad source directory.

Stale staging is purged before a transfer retry. Empty staging cleanup after success is best-effort and cannot turn a verified transfer into a failure.

## Multi-thread behavior

Defaults mirror the Copyarr recipe:

- 4 multi-thread streams
- 256M cutoff
- 3 retries
- 300 second retry wait

If rclone reports that multi-thread transfer is unsupported, Nexus retries that file once without multi-thread flags. Other rclone failures are surfaced normally.

Per-rule rclone arguments are applied only to the copy-to-staging phase. The agent reserves safety-critical flags so rule configuration cannot replace Nexus's config path, turn on dry-run, override telemetry/multi-thread controls, redirect overwrite backups, start rclone RC/dumps, or introduce command-backed password handling. Final commit, verification, source deletion and staging cleanup use Nexus-owned arguments only.

## Restart and retry behavior

Rule state, object generations and job IDs live in SQLite. A restart does not forget what was discovered or committed.

Each transfer attempt has a deterministic operation key derived from rule ID, object key and attempt number. Failed/partial/interrupted jobs enter `retry_wait` until the configured retry time, up to the bounded attempt budget. Cancelled objects are not retried automatically.

## Dashboard

The Transfers page exposes:

- enabled/paused rules
- source -> destination route
- scan/stability/bootstrap/retry settings
- discovered, queued, completed and failed counts/bytes
- manual Scan now
- recent object generations
- live transfer progress from normal Nexus runtime telemetry

The dashboard never receives rclone secrets.

## Deferred boundaries

Two Copyarr behaviors are intentionally deferred from the first M5 slice:

- **destination cleanup:** `cleanup_days` is persisted as policy, but Nexus does not delete old committed destination files yet. Cleanup must first carry the same provenance/identity guarantees as Copyarr.
- **rTorrent readiness:** stability is currently the readiness gate. rTorrent completion grouping/gating will be layered on top of the persistent rule/object model rather than replacing it.

These boundaries are deliberate: no cleanup or torrent-aware source deletion should be introduced as a hidden side effect of an otherwise successful copy job.
