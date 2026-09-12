# Transfer rules

Nexus Backup's M5 transfer engine ports the proven behavior of Copyarr into the existing Nexus job engine. It is not a second daemon with a separate queue: discovery, grouped transfers, ordinary transfers and cleanup are normal leased Nexus jobs, while rule/object state is stored in the local SQLite database.

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
- cleanup-days retention for committed destination objects
- optional rTorrent readiness gate by local gate ID

Endpoints and rTorrent gates are referenced only by configured IDs. The control plane and browser never receive rclone credentials, rTorrent RPC credentials, or the local rTorrent source-base mapping.

## Object identity and discovery

Discovery runs `rclone lsjson --recursive --files-only` against the configured source. The agent emits one bounded `transfer-discovery` telemetry event for the leased discovery job.

An object generation is identified by SHA-256 over:

```text
relative path + NUL + byte size + NUL + normalized modification time
```

This deliberately follows Copyarr's path + size + mtime identity. A file changed in place becomes a new generation instead of resurrecting an old completed/ignored object.

The first successful scan initializes the rule. With `ignore_existing`, generations seen in that first scan are persisted as ignored; future generations start as discovered. With `process_existing`, first-scan generations are eligible for readiness processing.

For ordinary files, a discovered generation is eligible only if it was also seen in the latest scan and its `stable_since` age meets the rule's stability window. This prevents a stale database row from being queued after the source object disappeared.

## rTorrent readiness and grouping

A transfer rule may reference a locally configured rTorrent gate. The agent queries rTorrent through XML-RPC `d.multicall2` and maps each torrent's `base_path` into the rule's rclone-relative source tree using the gate's local `sourceBasePath`.

The readiness behavior is:

- files belonging to known incomplete torrents are omitted from discovery and cannot become stable accidentally;
- files belonging to completed torrents are admitted immediately;
- files not associated with a known torrent continue to use the normal stability window;
- a `required: true` gate makes the discovery job fail if rTorrent cannot be queried;
- an optional gate falls back to the normal stability model when rTorrent is unavailable.

For **copy rules**, all currently pending files belonging to the same completed torrent are queued as one `managed-transfer` manifest job. rTorrent completion is therefore the readiness signal for that manifest; the ordinary stability delay is not applied to those grouped files. The existing staged transfer executor still copies and verifies every manifest item individually before committing it.

The group identity is the torrent info hash, while the current manifest fingerprint is derived from the object-generation keys. This keeps operation keys deterministic across scheduler retries without re-copying already completed generations. If a grouped transfer fails, the member generations enter the normal bounded retry state and are re-queued together as one group.

Torrent roots are applied from least-specific to most-specific so a nested torrent root deterministically overrides a broader parent root.

**Move rules deliberately remain per-file.** A multi-file move could otherwise delete some source files successfully and then fail during a later source deletion, making an atomic manifest retry impossible. The existing per-file verified move path preserves the safer failure boundary.

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

Rule state, object generations, torrent grouping metadata and job IDs live in SQLite. A restart does not forget what was discovered, grouped or committed.

Ordinary file attempts have deterministic operation keys derived from rule ID, object key and attempt number. Grouped copy attempts additionally include a hash of the torrent info hash plus a fingerprint of the pending object generations. Failed/partial/interrupted jobs enter `retry_wait` until the configured retry time, up to the bounded attempt budget. Cancelled objects are not retried automatically.

## Destination cleanup

A successful transfer stores a provenance record for each committed object generation and calculates `cleanup_after` from the rule's cleanup-days value.

Cleanup runs later as a separate `managed-cleanup` agent job. Before deleting anything, the agent runs an exact destination `stat` and requires the current byte size to equal the size Nexus recorded at commit time.

- exact match: delete that exact destination file;
- destination changed since commit: refuse cleanup permanently for that generation;
- transient rclone/network error: retry within the rule's bounded retry budget.

Cleanup never broad-purges a destination directory and never assumes that a path is still Nexus-owned merely because its retention date has passed.

## Dashboard

The Transfers page exposes:

- enabled/paused rules
- source -> destination route
- scan/stability/bootstrap/retry settings
- optional rTorrent gate ID
- discovered, queued, completed and failed counts/bytes
- manual Scan now
- recent object generations
- live transfer progress from normal Nexus runtime telemetry
- cleanup policy and state through the same persistent object model

The dashboard never receives rclone or rTorrent secrets.

## Current boundary

Completed-torrent manifest grouping is enabled for **copy** rules only. Verified move remains per-file by design because source deletion cannot be made safely atomic across an arbitrary multi-file manifest with rclone's current primitives.
