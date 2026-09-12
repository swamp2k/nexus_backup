# Restore workflow

Nexus Backup can browse Restic snapshot contents, run an exact restore dry-run, and perform an authenticated write restore to an explicitly enabled local target. Restore data never travels through the control plane; the agent talks directly to the Restic repository and local restore filesystem.

## Local restore targets

Restore destinations are defined only in the agent configuration:

```json
{
  "restoreTargets": [
    {
      "id": "restore-staging",
      "label": "Restore staging",
      "path": "/restore",
      "overwrite": "never",
      "allowWrite": true
    }
  ]
}
```

Jobs and browser requests contain only the target ID. The filesystem path is resolved by the agent and is never returned by the sanitized browser API or stored in restore job payloads.

Supported overwrite policies are `never`, `if-changed`, `if-newer`, and `always`; the default is `never`. Write restores are disabled by default. A target must explicitly set `allowWrite: true`; targets without that setting remain available for dry-run preview only.

Existing installations keep their existing `/config/agent.json`, so `restoreTargets` and `allowWrite` must be added deliberately when upgrading.

## Docker / Compose

The self-contained Compose stack exposes a dedicated restore staging mount to the agent:

```text
${NEXUS_BACKUP_RESTORE_PATH:-./.local/restore}:/restore
```

The default is for local development. Set `NEXUS_BACKUP_RESTORE_PATH` or provide the equivalent Unraid bind mount for a real installation. Nexus Backup does not hardcode a production host restore path.

## Snapshot browsing

Snapshot inventory provides snapshot IDs. Content browsing runs as a leased agent job using:

```text
restic ls --json <snapshot-id> <path>
```

Browsing is non-recursive. The dashboard begins at `/`; deeper paths are accepted only after a directory has been discovered for the same repository and snapshot. Results are bounded to 1,000 entries per directory response and cached in local SQLite. Browse telemetry is lease-bound to repository ID, snapshot ID, and requested path, and snapshot entry contents are kept out of the agent Docker log.

## Restore preview

Preview resolves repository and target IDs locally and runs the equivalent of:

```text
restic restore <snapshot-id> \
  --target <agent-local-target-path> \
  --dry-run \
  --verbose=2 \
  --overwrite <local-target-policy>
```

For a selected file or directory, Nexus Backup adds `--include <discovered-snapshot-path>`. The preview executor is hard-coded to dry-run and never supplies `--delete`. Its summary contains new, updated and unchanged counts plus local IDs, never the target filesystem path.

## Local authentication

The public local UI is fronted by an authenticated gateway. The existing control server binds only to loopback inside the control container.

On first startup, Nexus Backup creates a one-time setup token in `/config/setup-token` and prints it in the control-container log. The setup page requires that token plus a new local-admin password. The password is stored only as a scrypt hash in `/config/auth.json`; the setup token is removed immediately after setup.

Authenticated sessions are in-memory, expire after 12 hours, use an `HttpOnly`, `SameSite=Strict` cookie, and are invalidated by a control-container restart. Mutating `/v1/local/*` requests also require a session-bound CSRF token. Repeated failed logins are rate-limited.

Agent API traffic keeps its existing bearer-token authentication and does not require a browser session.

## Write restore authorization

A write restore is accepted only when all of these conditions hold:

1. the local-admin session is authenticated and the request passes CSRF validation;
2. the repository, snapshot, target ID and optional snapshot path pass the same local-ID/discovered-path checks as preview;
3. the selected restore target has `allowWrite: true` in the agent configuration;
4. a successful `restic-restore-preview` exists for the exact same repository, snapshot, target and path from the last 30 minutes;
5. the user types the exact confirmation phrase `RESTORE <snapshot-8> TO <target-id>`;
6. the gateway issues a scope-bound restore authorization token that expires after two minutes;
7. that authorization token is consumed once. Replays are rejected.

The resulting `restic-restore` job resolves the target path locally, uses the configured overwrite policy, shares the normal per-repository lock with backup/maintenance/inventory, and never uses `--delete`.

This makes the write path intentionally harder to trigger than ordinary backup work while keeping recovery usable from the same self-contained dashboard.
