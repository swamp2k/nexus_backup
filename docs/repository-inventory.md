# Repository inventory

Repository inventory is the read-only foundation for restore workflows in Nexus Backup.

## Flow

```text
Repositories UI
  -> POST /v1/local/repositories/:id/refresh
  -> restic-inventory job
  -> agent repository gate
  -> restic snapshots --json
  -> restic stats --json --mode raw-data
  -> lease-bound inventory telemetry
  -> local SQLite
  -> Repositories UI / snapshot browser
```

The control container never receives Restic credentials. The inventory job carries only a local `repositoryId`; the agent resolves the repository location, password file and environment from its local configuration.

## Read-only behavior

The inventory executor only runs:

- `restic snapshots --json --latest 250 --group-by ""`
- `restic stats --json --mode raw-data`

It does not run backup, forget, prune, restore or delete operations.

Inventory jobs share the same per-repository execution gate as backups and retention maintenance, so a scan does not overlap another Nexus Backup Restic operation against the same repository.

## Persistence

The latest successful inventory is stored in local SQLite as repository metadata plus a compact snapshot catalog. A failed later scan does not replace or delete the last successful catalog; the UI shows the failed scan state alongside the older known-good inventory.

Catalog replacement is atomic. Snapshot rows for a repository are replaced only after a complete, validated inventory event is received for the repository named by the active leased job.

Inventory survives ordinary job-history cleanup: the reference to its source scan job uses `ON DELETE SET NULL` rather than cascading deletion into the catalog.

## Bounds

The snapshot catalog is intentionally bounded:

- up to 250 recent snapshots per scan
- up to 16 paths and 32 tags per snapshot
- individual paths and tags are length-limited
- the serialized inventory telemetry event is capped below the local API request limit

If these bounds truncate a catalog, `truncated` is recorded and shown by the UI. This keeps inventory useful without allowing an unusually large repository description to exhaust the control-plane request path.

## Security boundary

- Browser routes expose only sanitized repository configuration plus persisted inventory.
- Repository credentials, password-file contents and environment secrets remain agent-local.
- Inventory telemetry is accepted only from the authenticated agent that holds the active job lease.
- The event `repositoryId` must exactly match the repository ID in the leased inventory job payload.
- Full inventory payloads are not written to the agent's structured Docker logs.

## What inventory is not

Inventory is not an integrity check. `restic stats` and `restic snapshots` describe repository contents; they do not replace `restic check`.

No restore or snapshot-delete action is exposed by this feature. The next restore milestone can build on the persisted snapshot IDs and add content browsing / dry-run restore without accepting arbitrary repository paths or credentials from the browser.
