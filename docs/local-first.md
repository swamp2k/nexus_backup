# Local-first architecture

Self-contained operation is the primary Nexus Backup deployment model.

## Primary mode

```text
Browser
  |
  v
nexus-backup control container
  - M4 web UI
  - HTTP control API
  - local SQLite database
  - migrations and lease recovery
  |
  | control traffic only
  v
nexus-backup agent container
  - local credentials
  - rclone
  - restic
  - FUSE
  - direct storage access
  |
  +--> sources
  +--> backup repositories / destinations
```

The two containers form one application. Splitting them is a privilege boundary: the UI/API container does not need FUSE or broad storage access, while the agent does.

## First-start bootstrap

The local control container creates its SQLite database and applies migrations automatically. It generates a persistent control token and local-agent token under `/config`. The agent token is mirrored into a private shared runtime volume, and the agent can read it through `NEXUS_BACKUP_AGENT_TOKEN_FILE`.

No Cloudflare account, D1 database, external database, or manually copied agent secret is required to start the local stack.

## Local authority

The local SQLite database is authoritative in primary mode. Agent credentials and storage credentials remain local. Backup payloads flow directly between the agent and storage endpoints.

## Optional remote control

Remote control may expose selected metadata and control operations through a relay/Worker, but it is an optional extension. Losing Internet access or the remote service must not prevent local UI access, scheduled local jobs, lease recovery, backup execution, history, or restore.

A remote-control implementation must never become a proxy for backup bytes and should not receive rclone credentials, restic passwords, SSH keys, or arbitrary local paths.

## Docker and Unraid

`compose.yaml` is the reference stack. Unraid can express the same two-container topology through templates. The agent requires `/dev/fuse` plus `SYS_ADMIN` for rclone mounts; the control container does not.

The reference Compose file intentionally uses configurable host mappings for `/data` and `/backup`. Production Unraid paths are deployment choices, not repository constants.
