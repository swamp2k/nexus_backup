# Transfer rules

Nexus Backup's M5 transfer engine ports the proven behavior of Copyarr into the existing Nexus job engine. Discovery, transfer and cleanup work are normal leased Nexus jobs, while rule/object state is stored in the local SQLite database.

## Rule model

A transfer rule describes:

- source rclone endpoint plus optional relative source path
- destination endpoint plus optional relative destination path
- copy or verified move mode
- first-scan behavior: `ignore_existing` or `process_existing`
- scan interval and stability window
- optional rTorrent readiness endpoint and whether RPC is required
- bounded retry count and retry wait
- include/exclude patterns
- exact-size verification
- Copyarr-style multi-thread streams/cutoff
- optional per-rule rclone tuning arguments
- destination cleanup window

Endpoints are referenced only by configured IDs. rclone credentials remain in the agent's rclone config. rTorrent password bytes are read from an agent-only `passwordFile`; the browser receives only the rTorrent endpoint ID.

## Object identity and discovery

Discovery runs `rclone lsjson --recursive --files-only` against the configured source. The agent emits one bounded `transfer-discovery` telemetry event for the leased discovery job.

An object generation is identified by SHA-256 over:

```text
relative path + NUL + byte size + NUL + normalized modification time
```

This follows Copyarr's path + size + mtime identity. A file changed in place becomes a new generation instead of resurrecting an old completed/ignored object.

The first successful scan initializes the rule. With `ignore_existing`, generations seen in that first scan are persisted as ignored; future generations start as discovered. With `process_existing`, first-scan generations enter the normal readiness flow.

A discovered object must also have been seen in the latest scan. This prevents a stale database row from being queued after the source object disappeared.

## rTorrent readiness

A rule can optionally reference a local rTorrent endpoint. The agent uses the same XML-RPC contract as Copyarr:

```text
d.multicall2
  d.hash=
  d.name=
  d.complete=
  d.base_path=
```

The rTorrent endpoint is local agent configuration, for example:

```json
{
  "rtorrentEndpoints": [
    {
      "id": "seedbox-rtorrent",
      "url": "https://seedbox.example/RPC2",
      "username": "user",
      "passwordFile": "/state/secrets/rtorrent-password",
      "view": "main",
      "sourceBasePath": "/media/sdm1/USER/private/rtorrent/complete"
    }
  ]
}
```

`/state` is mounted only in the agent container in the standard compose deployment, so the password bytes are not available to the control container.

For each discovered file the agent derives one of three readiness states:

- `rtorrent_complete`: the most-specific matching torrent root is complete; the file is immediately eligible without waiting for the stability window.
- `rtorrent_incomplete`: the file belongs to an incomplete torrent; it is blocked and **does not** fall through to stability.
- `stability`: rTorrent does not know the path, rTorrent is not configured, or optional rTorrent RPC is unavailable. The normal stability timer applies.

If a rule enables **Require rTorrent RPC**, an RPC failure fails the discovery job before rclone discovery runs. No stale object can become newly eligible because transfer eligibility still requires presence in the latest successful scan.

Only relative torrent root, hash/name and readiness are persisted. Absolute `sourceBasePath`, RPC URL, username and password bytes are not emitted in discovery telemetry.

The first rTorrent slice deliberately keeps **one file per managed transfer job**. Copyarr can group a complete multi-file torrent into one job, but Nexus does not do that yet because move-mode source deletion must remain recoverable if deletion of a later file fails.

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

## Destination cleanup

When `cleanupDays > 0`, a completed transfer records `cleanup_after` for that object generation. A separate `managed-cleanup` job is queued only after that time.

Cleanup is deliberately provenance-safe:

1. the cleanup payload contains the original object key, relative path and committed byte size;
2. the agent stats the exact destination file before deletion;
3. if the current size no longer matches the committed generation, deletion is refused permanently with `cleanup refused modified destination`;
4. otherwise only that exact file is deleted;
5. transient cleanup failures use the transfer rule's bounded retry policy.

An active cleanup job also locks the corresponding transfer-object row against deletion. Structural rule edits cannot erase that provenance while a cleanup job is still capable of deleting the destination.

## Multi-thread behavior

Defaults mirror the Copyarr recipe:

- 4 multi-thread streams
- 256M cutoff
- 3 retries
- 300 second retry wait

If rclone reports that multi-thread transfer is unsupported, Nexus retries that file once without multi-thread flags. Other rclone failures are surfaced normally.

Per-rule rclone arguments are applied only to the copy-to-staging phase. The agent reserves safety-critical flags so rule configuration cannot replace Nexus's config path, turn on dry-run, override telemetry/multi-thread controls, redirect overwrite backups, start rclone RC/dumps, or introduce command-backed password handling. Final commit, verification, source deletion, staging cleanup and managed destination cleanup use Nexus-owned arguments only.

## Restart and retry behavior

Rule state, object generations, readiness and job IDs live in SQLite. A restart does not forget what was discovered or committed.

Each transfer attempt has a deterministic operation key derived from rule ID, object key and attempt number. Failed/partial/interrupted jobs enter `retry_wait` until the configured retry time, up to the bounded attempt budget. Cancelled objects are not retried automatically.

Cleanup jobs have their own deterministic attempt keys and retry counters so a cleanup retry never looks like a transfer retry.

## Dashboard

The Transfers page exposes:

- enabled/paused rules
- source -> destination route
- stability or rTorrent readiness policy
- scan/bootstrap/retry settings
- discovered, queued, completed, failed and cleaned lifecycle state
- manual Scan now
- recent object generations with readiness reason
- live transfer progress from normal Nexus runtime telemetry

The dashboard receives only rTorrent endpoint IDs, never RPC URLs, usernames, password-file contents or absolute rTorrent source paths.

## Deferred boundary

**Grouped torrent jobs** remain intentionally deferred. rTorrent readiness gating is active, but Nexus still schedules one file per transfer job. Grouped copy can come first; grouped move must wait for explicit partial-source-delete recovery semantics.

That boundary is deliberate: grouped source deletion must not appear as a hidden side effect of an otherwise successful copy job.
