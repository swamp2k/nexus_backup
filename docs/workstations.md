# Workstation backup

Nexus Backup workstation support is a separate Windows data-plane agent. PCWatch is not part of the backup path; it may simply execute the installer command that Nexus generates.

## Enroll

In **Workstations**, choose **Add workstation**. Nexus creates a short-lived bootstrap credential and shows a one-line elevated PowerShell command:

```powershell
$env:NEXUS_BACKUP_URL='http://nexus-host:8787';$env:NEXUS_BACKUP_TOKEN='nxbdev_...';irm 'http://nexus-host:8787/install.ps1'|iex
```

The command keeps the simple `nxbdev_` format, but the credential embedded in a fresh enrollment command is **not** the durable workstation credential. It is a one-shot bootstrap credential that:

- is stored by Nexus only as a SHA-256 hash;
- expires 15 minutes after the workstation entry is created;
- cannot authenticate the normal workstation poll/status/job APIs before bootstrap;
- is atomically consumed on the first installer report;
- is immediately rotated to a new long-lived device token returned directly to the target PC;
- cannot be reused after the rotation.

This makes the generated command suitable for a launcher such as PCWatch: the launcher can carry a short-lived enrollment credential without ever receiving the durable Nexus workstation token.

Repair/update is different from first enrollment. Once installed, the machine keeps its durable device token in the protected local configuration, so rerunning `install.ps1` uses that local token rather than requiring or consuming another bootstrap credential.

The installer:

- requires Administrator/System rights and Windows x64;
- exchanges a fresh bootstrap credential directly with Nexus before storing the durable device token;
- downloads the latest stable Nexus workstation executable and verifies its published SHA-256 checksum;
- installs pinned Restic 0.19.1 and verifies its pinned checksum;
- stores binaries below `%ProgramFiles%\Nexus Backup Workstation`;
- stores local configuration/state below `%ProgramData%\NexusBackup`;
- restricts the local data directory to SYSTEM and local Administrators;
- registers an AtStartup scheduled task running as SYSTEM;
- preserves the local repository/password configuration on repair/update.

A later native Windows service wrapper may replace Task Scheduler without changing the Nexus API contract.

## Local storage configuration

Nexus intentionally does **not** store workstation repository credentials. The local file is:

```text
C:\ProgramData\NexusBackup\workstation.json
```

The important local-only fields are:

```json
{
  "repository": "sftp:user@backup-host:/srv/restic/balder-pc",
  "passwordFile": "C:\\ProgramData\\NexusBackup\\restic-password"
}
```

Put the Restic password in the referenced password file. Repository and password are never returned by the workstation agent. Nexus sees only `repositoryConfigured` and a coarse backend kind such as `sftp`, `local`, or `rest`.

For local filesystem repositories, the agent may initialize a missing repository when `autoInit` is true. Remote repositories are never auto-initialized merely because `restic cat config` failed; authentication/network errors remain failures.

The installer also accepts `NEXUS_BACKUP_REPOSITORY` and `NEXUS_BACKUP_RESTIC_PASSWORD` environment variables for unattended first setup. They are consumed locally and are not submitted to Nexus.

## Policy

Nexus stores the workstation backup policy:

- one or more absolute Windows source paths;
- Restic exclude patterns;
- daily or weekly schedule;
- IANA timezone;
- daily/weekly/monthly retention counts.

A due policy creates one durable workstation run. The workstation polls for work and receives an expiring per-run lease token. A stale lease is requeued. Reusing a consumed or expired lease token is rejected.

If a workstation remains offline, Nexus keeps at most the durable active run rather than relying on backup bytes or credentials in the control plane.

## Backup execution

The workstation runs Restic locally:

```text
restic backup --json --host <hostname> --tag nexus-workstation:<device-id> --use-fs-snapshot ...
```

On Windows, `--use-fs-snapshot` requests a VSS-backed filesystem snapshot so open/locked files can be read consistently when supported.

After a successful backup, retention is applied with plan-scoped workstation tags. Restic exit code 3 is recorded as `partial`, not as a successful backup. Retention is not executed after a failed/partial backup.

The agent reports bounded progress and results to Nexus: progress percentage/bytes/files/current path, final snapshot id, file counts, data added, duration and redacted error text. Repository URLs and the password-file path are redacted from errors before transmission.

## Dashboard status

The Workstations page shows:

- online/offline;
- installed agent version;
- storage readiness (without storage address);
- last successful backup and snapshot id;
- next scheduled run;
- current progress;
- last run state/error;
- sources/excludes/retention policy;
- **Run now**.

## Release/versioning

A Nexus SemVer tag publishes all coordinated components:

- `nexus-backup-control` Docker image;
- `nexus-backup-agent` Docker image;
- `nexus-backup-workstation-windows-amd64.exe` GitHub Release asset;
- SHA-256 checksum file for the workstation executable.

Stable releases become the source for the `irm` install/update flow. Prereleases do not replace the stable GitHub `latest` release.

## Current boundary

Workstation backup is backup-only in M6. Workstation snapshot browsing/write restore is deliberately left for M7. Until then, use Restic directly with the workstation's local repository configuration for recovery testing.
