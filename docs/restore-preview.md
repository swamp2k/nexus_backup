# Restore preview

Nexus Backup restore v1 deliberately stops before writing files. The local dashboard can browse snapshot contents and run a real Restic restore dry-run, but actual restore execution remains disabled until the local UI has authentication/session protection and an explicit confirmation flow.

## Local restore targets

Restore destinations are defined only in the agent configuration:

```json
{
  "restoreTargets": [
    {
      "id": "restore-staging",
      "label": "Restore staging",
      "path": "/restore",
      "overwrite": "never"
    }
  ]
}
```

Jobs and browser requests contain only the target ID. The target filesystem path is resolved by the agent and is not returned by the sanitized local config endpoint or stored in restore-preview job payloads.

Supported overwrite policies are `never`, `if-changed`, `if-newer`, and `always`. New targets default to `never` when no policy is supplied.

Existing installations keep their existing `/config/agent.json`; add `restoreTargets` manually when upgrading. The bundled example is only copied on first bootstrap.

## Docker / Compose

The self-contained Compose stack exposes a dedicated restore staging mount to the agent:

```text
${NEXUS_BACKUP_RESTORE_PATH:-./.local/restore}:/restore
```

The default is for local development. Set `NEXUS_BACKUP_RESTORE_PATH` or provide the equivalent Unraid bind mount for a real installation. Do not hardcode a production host path in the repository.

## Snapshot browsing

Snapshot inventory provides snapshot IDs. Content browsing runs as a normal leased agent job and uses:

```text
restic ls --json <snapshot-id> <path>
```

Browsing is non-recursive. The dashboard begins at `/`; deeper paths are accepted only after a directory has been discovered in a previous browse result for the same repository and snapshot. Results are bounded to 1,000 entries per directory response and stored in local SQLite.

Browse telemetry is lease-bound to repository ID, snapshot ID, and requested path. Snapshot entry contents are not copied into the agent's Docker log.

## Restore preview

A preview job resolves the repository and target ID locally, then runs Restic with the equivalent of:

```text
restic restore <snapshot-id> \
  --target <agent-local-target-path> \
  --dry-run \
  --verbose=2 \
  --overwrite <local-target-policy>
```

When a single discovered file or directory is previewed, Nexus Backup adds `--include <snapshot-path>`.

The preview executor always sets `--dry-run`; there is no job payload flag that can disable it. It never supplies `--delete`. The resulting summary records counts for new, updated, and unchanged entries plus the target ID, but not the target filesystem path.

## Security boundary

The current dashboard is trusted-LAN UI without user authentication. Therefore:

- snapshot browsing is read-only;
- restore preview is dry-run only;
- there is no API or UI action that performs a writing restore;
- raw restore target paths cannot be supplied by the browser;
- actual restore must wait for local authentication/session support;
- future restore execution must require a strong explicit confirmation and use the same preconfigured target-ID boundary.

This keeps restore-readiness useful without quietly expanding the existing trusted-LAN surface into a filesystem write primitive.
