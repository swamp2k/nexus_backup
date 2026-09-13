# Fresh install: Unraid + Windows workstation

This runbook installs Nexus Backup from a clean state without relying on prior chat history. It is intentionally conservative and is written for the current local-first beta architecture.

It does **not** cut over any existing production backup workload. PCWatch-backup and standalone Copyarr remain untouched until the isolated acceptance procedure in `docs/acceptance-test.md` has passed and a later cutover is explicitly approved.

## 1. Deployment model

Nexus Backup is one product split into two Unraid containers plus a Windows workstation agent:

```text
Browser
  -> NexusBackup-Control
       - UI/API
       - local auth
       - SQLite
       - schedules/job state

NexusBackup-Agent
  - Restic/rclone/FUSE
  - local storage mappings
  - local repository/rclone credentials

Windows workstation agent
  - runs backup/recovery locally on Windows
  - owns its own Restic repository location/password
  - talks to Control only for metadata/orchestration
```

Control never receives generic-agent storage secrets or workstation repository credentials, and backup payloads do not flow through Control.

## 2. Before installing

Record the exact coordinated release you intend to test. The two container images must use the same Nexus release tag/digest. The beta Unraid XML templates currently default to `latest`; for reproducible acceptance, pin both templates to the same explicit release tag once a release image exists.

Verify these prerequisites:

- Docker is available on Unraid.
- TCP 8787 is unused on the Unraid host.
- `/dev/fuse` exists for the generic agent.
- you have selected persistent host paths for Control config, shared runtime, Agent config, and Agent state.
- you have selected **separate** host paths for any source data, backup repositories and restore staging.
- the chosen source mapping does not contain the backup repository or restore-staging mapping beneath it.

That final point is a hard safety rule. For example, a broad source mapping such as `/data -> /mnt/user` can also expose a repository stored under `/mnt/user/backups/...` through the `/data` tree. Do not configure a source path that can descend into its own repository or restore staging. Prefer mapping `/data` directly to the narrow share/directory that is intended to be protected.

The repository templates contain convenience defaults, but host paths are deployment choices. Do not copy a default into production merely because it exists in XML.

## 3. Install NexusBackup-Control on Unraid

Use `unraid/templates/nexus-backup-control.xml` or the equivalent Unraid template values.

The current container contract is:

| Container path | Purpose | Required property |
| --- | --- | --- |
| `/config` | SQLite, local auth, generated control identity | persistent, read/write |
| `/run/nexus-backup` | generated local-agent token mirror | persistent/shared with Agent |
| `/agent-config` | sanitized read-only view of Agent config | same host directory as Agent `/config`, read-only |

Control uses host networking and listens on port 8787. It must **not** receive `/dev/fuse`, `SYS_ADMIN`, source-data mappings or backup-repository mappings.

Start Control first. Confirm:

```text
http://<unraid-ip>:8787/healthz
```

returns healthy before installing the Agent.

### First local-admin bootstrap

On a brand-new Control config volume, Nexus creates a one-time setup token and logs it in the Control container log. Open:

```text
http://<unraid-ip>:8787/
```

and complete the local-admin setup using that token and a new password.

After setup, `/config/auth.json` becomes the persistent local-auth record and the setup token is removed. Browser sessions are disposable; the auth record is not.

Control also creates persistent control/local-agent tokens under `/config`. The local-agent token is mirrored into the shared runtime directory for the Agent. Do not copy these values into browser-visible configuration.

## 4. Install NexusBackup-Agent on Unraid

Use `unraid/templates/nexus-backup-agent.xml` or equivalent values. Keep the matching Control/Agent shared paths identical on the host.

The current contract is:

| Container path | Purpose | Access |
| --- | --- | --- |
| `/config` | `agent.json`, Restic passwords, rclone config | read/write |
| `/run/nexus-backup` | local-agent token from Control | read-only |
| `/state` | Restic/rclone cache/runtime state | read/write |
| `/data` | protected source root(s) | read-only |
| `/backup` | local repository root(s) | read/write |
| `/restore` | restore staging root | read/write |
| `/downloads` | managed transfer destination root | read/write |

Only Agent receives:

```text
--cap-add=SYS_ADMIN
--device=/dev/fuse
```

With both containers on host networking, the Agent Control URL remains:

```text
http://127.0.0.1:8787
```

and the token file remains:

```text
/run/nexus-backup/agent-token
```

### Fresh Agent is intentionally inert

If `/config/agent.json` does not exist, the current image creates an intentionally empty starter config:

```json
{
  "sources": [],
  "resticRepositories": [],
  "restoreTargets": [],
  "rcloneEndpoints": [],
  "rtorrentGates": [],
  "tools": {}
}
```

This is a safety feature. A fresh installation must not automatically point at data, repositories, restore targets or remote systems.

`config/agent.example.json` is a worked example only. Copy/adapt individual sections deliberately; it is not the startup default.

### Configure generic-agent storage deliberately

For a local source/repository pair, a minimal shape is:

```json
{
  "sources": [
    {
      "id": "my-source",
      "paths": ["/data/my-source"]
    }
  ],
  "resticRepositories": [
    {
      "id": "my-repository",
      "repository": "/backup/restic/my-repository",
      "passwordFile": "/config/secrets/restic-password"
    }
  ],
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

Before starting jobs, verify all of the following:

- `/data/my-source` resolves only to the intended protected data.
- the host path behind `/backup` is **not** below the host source path represented by `/data/my-source`.
- the host path behind `/restore` is **not** below the protected source path.
- Restic passwords and rclone credentials live under Agent config or another Agent-only local secret location, never in Control/API payloads.
- destructive rclone move remains disabled unless a source endpoint explicitly opts in.

Validate the file inside the running Agent container:

```sh
docker exec NexusBackup-Agent node apps/agent/bin/agent.mjs --check-config
```

Do not queue a job until the config check is clean and the dashboard shows the expected local agent/version.

## 5. Workstation repository prerequisite

A Windows workstation writes Restic data **directly** to the repository configured in:

```text
C:\ProgramData\NexusBackup\workstation.json
```

The generic Unraid Agent's `/backup` mount does not automatically expose a network repository to Windows.

For the final workstation-to-Unraid acceptance proof, provision a dedicated **test-only Restic endpoint on Unraid that the Windows SYSTEM account can actually reach using the intended transport**. Examples may include a correctly secured SFTP/REST/other Restic-supported endpoint, but Nexus Backup does not create that endpoint for you today.

Do not guess credentials or reuse a PCWatch production repository. The acceptance repository must be new and isolated.

A workstation-local repository can be used for an installer/execution smoke test, but it is **not** proof of the intended Windows -> Unraid data path.

## 6. Enroll the Windows workstation

In the Nexus **Workstations** page choose **Add workstation**. Nexus generates an elevated one-line PowerShell command shaped like:

```powershell
$env:NEXUS_BACKUP_URL='http://nexus-host:8787';$env:NEXUS_BACKUP_TOKEN='nxbdev_...';irm 'http://nexus-host:8787/install.ps1'|iex
```

Run the generated command promptly as Administrator/System on the test workstation.

The enrollment token is one-shot and expires after 15 minutes. It is not the durable workstation credential. The installer downloads the matching workstation executable, pinned Restic executable and checksums from the local Control image **before** consuming that one-shot credential, then exchanges it directly for a durable device token stored locally.

Normal install paths are:

```text
%ProgramFiles%\Nexus Backup Workstation
%ProgramData%\NexusBackup
```

The installer registers the `NexusBackupWorkstation` Scheduled Task as SYSTEM at startup.

Verify on Windows:

```powershell
Get-ScheduledTask -TaskName NexusBackupWorkstation
Get-Content 'C:\ProgramData\NexusBackup\workstation.json'
```

Do not paste or publish the `deviceToken` from that file.

## 7. Configure workstation storage locally

The relevant local-only fields are:

```json
{
  "repository": "<dedicated test Restic repository>",
  "passwordFile": "C:\\ProgramData\\NexusBackup\\restic-password"
}
```

Write the Restic repository encryption password into the referenced local password file and keep the ProgramData ACL restricted to SYSTEM and local Administrators.

Remote transport authentication is outside the controller and must already work in the Scheduled Task's SYSTEM context. Test that context rather than assuming an interactive user credential/key will also work for SYSTEM.

For unattended first setup, the installer can consume `NEXUS_BACKUP_REPOSITORY` and `NEXUS_BACKUP_RESTIC_PASSWORD` locally; neither value is sent to Control.

After the task restarts/reports, the Workstations page should show the device online and storage-ready without revealing repository URL or password-file path.

See `docs/workstations.md` for the full workstation execution/recovery contract.

## 8. Create the first Nexus emergency bundle

Once Control auth, Agent config/secrets and device enrollment are in a trusted state, immediately create and verify an emergency bundle using `docs/emergency-recovery.md`.

Also archive the exact pinned control + agent container images as described there. The recovery bundle contains privileged secrets and must be stored encrypted/off-host.

Do this **before** relying on Nexus as the only record of the new installation.

## 9. Ready for isolated acceptance

Do not migrate a production workload yet. A fresh install is only ready to enter `docs/acceptance-test.md` when all of these are true:

- Control and Agent use the same recorded release.
- local admin login works.
- local Agent is online with valid config.
- Agent starts from an explicit config, not the worked example by accident.
- source/repository/restore host paths cannot recurse into one another.
- workstation is online and storage-ready.
- the workstation test repository is isolated from PCWatch and any production Nexus repository.
- an emergency bundle has been created and verified.
- PCWatch-backup and Copyarr have not been disabled, changed or repointed.

If any item is uncertain, stop before acceptance and resolve it rather than testing against production data or repositories.
