# Single-container Nexus Backup appliance

Nexus Backup is packaged for Unraid as **one app and one container**.

The container runs three coordinated internal processes:

- Control: dashboard/API/auth/SQLite on port 8787.
- Agent: local Restic/rclone/transfer executor, talking only to Control on `127.0.0.1`.
- Repository: TLS-authenticated Restic REST endpoint for Windows workstations on port 8000.

This is an intentional product trade-off for Unraid. The previous three-container deployment offered stronger Docker mount-namespace isolation, but exposed Nexus as three separate Community Apps and required coordinated installation/update of three images. For a local Unraid appliance, one install/update surface is preferred.

The single container remains non-privileged by default and does not receive `SYS_ADMIN` or `/dev/fuse`. Optional FUSE-backed remote-source mounting remains an explicit advanced privilege expansion.

Persistent layout inside the appliance:

```text
/config/control       Control DB/auth/secrets
/config/agent         Agent config and local storage credentials
/config/repository    Repository TLS/auth/client material
/state                Agent caches/state
/backup/generic       Generic Agent Restic repositories
/backup/workstations  Windows workstation Restic repositories
```

The backup source root is mounted read-only at `/data`. Restore staging and transfer destinations remain separate writable mounts.

The runtime agent token is no longer a persistent/shared host mapping. Control creates it beneath `/run/nexus-backup`; Agent consumes it locally during the same container lifetime.

The appliance supervisor starts Control and Repository first, waits for Control to create the local Agent token, then starts Agent. If any of the three core processes exits, the supervisor terminates the entire appliance so Docker/Unraid restart policy can recover the coordinated unit. A half-alive UI is not considered healthy.

## Security boundary trade-off

The single-container model cannot reproduce the old Docker mount-namespace separation between Control, Agent and Repository. They share one container namespace. The remaining hard boundaries are therefore application validation, filesystem layout, read-only source mounts, local-only Control/Agent transport, TLS/auth for workstation repository traffic, staging-only restore invariants, credential redaction and least-privilege container configuration.

This trade-off is explicit and accepted for the Unraid product target. Backup/recovery security must not assume that the Unraid host itself is a hostile multi-tenant boundary.
