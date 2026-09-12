# Unraid agent runtime

The Nexus Backup agent is designed to run in a local container on Unraid. Nexus remains the control plane; storage credentials, rclone configuration, restic passwords, mount points and repository locations remain local to the agent.

## Remote-as-source backup lifecycle

A `rclone-restic-backup` job contains only local IDs:

```json
{
  "sourceEndpointId": "cloud-source",
  "repositoryId": "cloud-backup-repository",
  "tags": ["cloud"]
}
```

The agent resolves those IDs from its local runtime configuration and performs:

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

## Local mount policy

Each rclone endpoint that may be used as a backup source must explicitly configure a local mount policy. Example shape:

```json
{
  "id": "cloud-source",
  "fs": "remote:",
  "mount": {
    "mountPoint": "/state/mounts/cloud-source",
    "cacheDir": "/state/rclone-vfs/cloud-source",
    "vfsCacheMode": "full",
    "vfsCacheMaxSize": "50G",
    "daemonWait": "1m",
    "dirCacheTime": "5m",
    "pollInterval": "1m"
  }
}
```

These are container-internal example paths only. Host mappings are intentionally not defined in the repository; they must match the actual Unraid installation.

Remote backup mounts are always started read-only by the agent. Arbitrary mount flags can only come from the local endpoint configuration, never from a job payload.

## FUSE container requirements

`rclone mount` inside a Linux container requires FUSE access. The Unraid container will need the host FUSE device exposed and the capability required to create the mount. The final Unraid template should therefore expose `/dev/fuse` and add the required mount capability rather than running the whole agent privileged.

The mount and restic process run in the same container namespace, so the FUSE mount does not need to be propagated back to the Unraid host for backup jobs.

## Cleanup semantics

- rclone daemon mode is used so the startup command waits for the mount to become ready before restic starts.
- every remote backup attempts unmount after restic, including `partial`, failure and cancellation paths.
- unmount uses an independent timeout, because the job AbortSignal may already be cancelled.
- an unmount failure is a job failure; it is never silently ignored.
- only one active mount per configured endpoint is allowed inside one agent process.

## Next runtime work

The next step is packaging the agent process itself:

- JSON runtime-config loader
- long-running polling loop around `AgentRunner`
- structured stdout logging
- SIGTERM/SIGINT shutdown
- Docker image containing Node, rclone, restic and fuse3
- Unraid template with explicit `/config`, `/state`, repository/data mappings and `/dev/fuse`

No concrete host path, Cloudflare Worker target or D1 database should be added until those values are selected for the actual installation.
