# Unraid agent runtime

The Nexus Backup agent is designed to run in a local container on Unraid. Nexus remains the control plane; storage credentials, rclone configuration, restic passwords, mount points and repository locations remain local to the agent.

## Runtime status

The repository now contains a runnable agent service:

- `apps/agent/bin/agent.mjs` - process entrypoint
- `apps/agent/bin/runtime.mjs` - JSON config loader and polling loop
- `config/agent.example.json` - local configuration example
- `Dockerfile.agent` - Node + rclone + restic + fuse3 runtime image
- CI builds the agent image after the unit/integration test gate succeeds

The image is intentionally not published to a registry yet. A registry/image name will be selected when the actual Unraid deployment is wired up.

## Runtime environment

Required environment variables:

```text
NEXUS_BACKUP_URL
NEXUS_BACKUP_AGENT_ID
NEXUS_BACKUP_AGENT_TOKEN
```

Optional variables:

```text
NEXUS_BACKUP_CONFIG=/config/agent.json
NEXUS_BACKUP_POLL_INTERVAL_MS=5000
NEXUS_BACKUP_LEASE_TTL_MS=<server-compatible positive integer>
NEXUS_BACKUP_AGENT_VERSION=0.5.0
```

`NEXUS_BACKUP_AGENT_TOKEN` is never part of the JSON config example and must be supplied as a container secret/environment value.

The configured `NEXUS_BACKUP_AGENT_ID` should match the agent identity associated with that token in the control plane.

## Container filesystem contract

The image creates these container-internal locations:

```text
/config                 local configuration, rclone config, password files
/state                  disposable/persistent agent runtime state and caches
/state/mounts           rclone FUSE mount points
/state/rclone-vfs       optional rclone VFS caches
/state/restic-cache     optional restic cache
/data                   local source/destination mappings
/backup                 local backup repository mappings
```

They are container contracts, not proposed Unraid host paths. Host mappings must be chosen from the actual Unraid storage layout before deployment.

## Remote-as-source backup lifecycle

A `rclone-restic-backup` job contains only local IDs:

```json
{
  "sourceEndpointId": "cloud-source",
  "repositoryId": "cloud-backup-repository",
  "tags": ["cloud"]
}
```

The agent resolves those IDs from `/config/agent.json` and performs:

```text
rclone remote
    |
    | read-only FUSE mount
    v
local mount point
    |
    | restic backup
    v
restic repository
    |
    +-- guaranteed unmount cleanup
```

The control plane cannot supply the rclone remote name, mount path, VFS cache path, restic repository URL/path or credentials.

## FUSE requirements

The final Unraid container needs access to `/dev/fuse` and the mount capability required by rclone. Prefer the narrow FUSE device + mount capability setup over running the complete agent container privileged.

The mount and restic process run in the same container namespace, so the FUSE mount does not need to be propagated back to the Unraid host for backup jobs.

## Lifecycle and shutdown

The service continuously claims one job at a time from the control plane. When no work is available it sleeps for the configured poll interval. Failed iterations are logged and retried after the same interval.

`SIGTERM` and `SIGINT` abort the active `AgentRunner`. Active command processes already support TERM -> KILL escalation. Remote backup cleanup uses a separate unmount timeout so an aborted job still gets an unmount attempt.

Logs are JSON lines on stdout/stderr so Unraid/Docker can retain them without an application-specific logfile.

## Config validation

Inside the built image, configuration can be validated without starting the polling service:

```text
node apps/agent/bin/agent.mjs --check-config
```

or via the workspace script:

```text
npm run check-config --workspace @nexus-backup/agent
```

## Deployment still intentionally unresolved

Before creating the Unraid template we still need the actual deployment values:

- control-plane Worker URL
- D1 database/Worker deployment target
- agent identity/token
- Unraid host mappings for config, state, backup repositories and data
- the desired container image registry/name

Those values are not guessed or committed by the repository.
