# Fresh install: Unraid + Windows workstation

This runbook installs Nexus Backup from a clean state using the current **one-app / one-container** Unraid architecture.

It does **not** cut over any existing production backup workload. PCWatch-backup and standalone Copyarr remain untouched until the isolated acceptance procedure in `docs/acceptance-test.md` has passed and a later cutover is explicitly approved.

## 1. Deployment model

Nexus Backup is one Unraid container plus optional Windows workstation agents.

Inside the container, three coordinated internal services run together:

```text
Browser / workstation control
  -> Control (:8787)
       - UI/API
       - local auth
       - SQLite
       - schedules/job state

Agent
  - generic Restic/rclone/transfer execution
  - local source/repository mappings
  - talks to Control only at 127.0.0.1

Repository (:8000 TLS by default)
  - Restic REST endpoint for Windows workstations
  - dedicated workstation repository storage
  - TLS 1.3 + bcrypt authentication + private namespaces

Windows workstation agent
  - runs backup/recovery locally on Windows
  - sends backup bytes directly to Repository
  - owns its Restic encryption password and REST transport credential locally
  - talks to Control only for metadata/orchestration
```

For a LAN workstation the two paths may both use the local Unraid address. For an off-LAN workstation the supported topology is deliberately split:

```text
small control traffic:
Remote PC -> HTTPS / optional Cloudflare Tunnel -> Control

backup payload:
Remote PC -> direct HTTPS -> Repository -> /backup/workstations
```

Cloudflare or another remote-control transport is optional and carries only orchestration/metadata. **Backup payloads never flow through Control or Cloudflare.** A VPN overlay is not required.

The one-container packaging intentionally trades the old Docker mount-namespace separation for Unraid simplicity: one Community Apps entry, one install, one image update and one WebUI.

## 2. Before installing

Record the exact Nexus release/tag/digest you intend to test. Reproducible acceptance must use an immutable image digest.

The Community Apps/Unraid template intentionally uses `:latest` for normal stable distribution. **Do not leave the Repository field on `:latest` during acceptance.** Override it with the exact recorded digest:

```text
ghcr.io/swamp2k/nexus-backup@sha256:<recorded-digest>
```

Verify:

- Docker is available on Unraid;
- TCP 8787 and the local Repository listen port (default 8000) are free;
- PCWatch and existing production backup repositories are not under the Nexus backup root;
- you know the canonical DNS name or IPv4 address workstations will use for Repository;
- for Internet mode, that public/DDNS name resolves to your Internet connection and the router/firewall can forward the advertised port to Tower's Repository listen port;
- if local PCs use the same public hostname, either split DNS or NAT loopback/hairpin makes it reachable internally.

The default mappings are:

```text
/config      /mnt/user/appdata/nexus-backup              read/write
/state       /mnt/user/appdata/nexus-backup-state        read/write
/data        /mnt/user/nexus-backup-source               read-only
/backup      /mnt/user/backups/nexus-backup              read/write
/restore     /mnt/user/restore/nexus-backup              read/write
/downloads   /mnt/user/downloads                         read/write
```

Inside `/backup`, Nexus separates:

```text
/backup/generic       generic Agent repositories
/backup/workstations  Windows workstation repositories
```

Do not map the whole `/mnt/user` tree as `/data` merely for convenience. Source/repository/restore containment remains a hard safety rule.

`/dev/fuse` is **not** a normal prerequisite. The default appliance has no `SYS_ADMIN`, no `/dev/fuse` and is not privileged.

## 3. Install NexusBackup

Use `unraid/templates/nexus-backup.xml` or equivalent values, but for acceptance replace the template's `:latest` value with the immutable digest recorded in section 2 before creating/starting the container.

Repository settings are deliberately separate from the Control endpoint:

- **Exposure**: `lan` or `internet`.
- **Endpoint host**: canonical DNS name/IP embedded in the pinned Repository certificate.
- **Listen port**: local Tower port, default `8000`.
- **Endpoint port**: port advertised to workstations; it may differ from the listen port.
- **Append-only**: Internet mode defaults this to `true` on first configuration.

A typical direct-Internet setup is:

```text
backup.example.com:443  -> router/firewall -> Tower:8000
```

so configure:

```text
Repository exposure:      internet
Repository endpoint host: backup.example.com
Repository listen port:   8000
Repository endpoint port: 443
Repository append-only:   true
```

Only the Repository endpoint needs the Internet port-forward. **Do not forward Control :8787 merely because Repository is public.**

The endpoint host is used in the generated self-signed Repository TLS certificate. Workstations receive that CA out-of-band from the local Nexus helper and pin it by SHA-256. Changing the endpoint identity later requires a Nexus restart and workstation reprovisioning with the new pinned CA.

Start **NexusBackup** and verify:

```text
http://<unraid-ip>:8787/healthz
```

The appliance supervisor starts Control and Repository first, waits for Control to create the local Agent token, then starts Agent. If any core service exits, the appliance stops as one unit.

### First local-admin bootstrap

A brand-new `/config/control` creates a one-time setup token and writes it to the privileged NexusBackup container log. Open:

```text
http://<unraid-ip>:8787/
```

and complete local-admin setup. After setup, auth state is persistent under `/config/control` and the one-time setup token is removed.

## 4. Repository network/protection GUI

After login open **Settings -> Workstation Repository -> Network & protection**.

The GUI persists the authoritative Repository network policy beneath:

```text
/config/repository/settings
```

It controls LAN/Internet exposure, endpoint identity, local listen port, advertised endpoint port and append-only. Listener/TLS-policy changes require restarting the single `NexusBackup` container; the UI shows saved and currently running policy separately and flags when a restart is required.

Current enforced protections are:

- TLS with minimum TLS 1.3;
- random strong per-workstation transport passwords stored as bcrypt server-side hashes;
- private per-principal repository namespaces;
- pinned Repository CA on each workstation;
- optional append-only, default-on for first-time Internet mode.

Rate limiting and brute-force lockout are **not currently built into the direct Restic endpoint** and the UI must not claim otherwise. Strong random credentials make password guessing impractical, but a later edge/gate layer may add traffic-rate controls if desired.

Append-only is intentionally destructive-operation protection: a compromised remote workstation may add backups but cannot delete or modify existing repository objects through the REST endpoint. Consequently remote workstation `forget/prune` is not the retention mechanism for Internet repositories. Production retention must be performed locally on Tower/Nexus in a later milestone.

## 5. Remote Control path for off-LAN workstations

Direct Repository exposure solves the backup-data path, but a workstation still needs Control for enrollment, job polling and status.

For off-LAN PCs, expose **Control separately** over a small HTTPS remote-control path. The recommended beta topology is a Cloudflare Tunnel (or equivalent HTTPS transport) to local Control :8787 and an explicit:

```text
NEXUS_BACKUP_PUBLIC_URL=https://nexus-control.example.com
```

This URL is used for workstation enrollment/control traffic. Nexus intentionally does not trust arbitrary forwarded Host/Proto headers when generating installer/control origins.

Do not route the Repository hostname through that Cloudflare Tunnel. Keep the roles distinct:

```text
nexus-control.example.com  -> Cloudflare Tunnel -> Control :8787
backup.example.com:443     -> direct port forward -> Repository :8000
```

This preserves the design rule that backup bytes never traverse Cloudflare while avoiding raw Internet exposure of the dashboard/API.

## 6. Fresh Agent config

If `/config/agent/agent.json` does not exist, Nexus creates this inert starter config:

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

Validate it with:

```sh
docker exec NexusBackup node /app/apps/agent/bin/agent.mjs --check-config
```

A generic write restore target is a **staging root**, never an in-place destination. Validation requires `overwrite: "never"`; write restore creates a fresh run-specific staging directory.

## 7. Repository service inside the same container

Repository state lives beneath `/config/repository`; workstation payloads live beneath `/backup/workstations`.

Repository uses official `rest-server` v0.14.0 pinned and SHA-256 verified during the Nexus image build. There is no HTTP CA/bootstrap port and no required reverse proxy in the backup data path.

The fact that Repository shares a container with Control/Agent does **not** change the credential rule: Control never receives REST transport credentials or workstation Restic encryption passwords.

## 8. Create a workstation Repository principal

From the **NexusBackup container console**, create a dedicated principal/namespace. For the isolated Balder acceptance test:

```sh
nexus-repository-client balder-pc acceptance
```

The helper creates/reuses a random transport password and prints PowerShell values for:

```text
NEXUS_BACKUP_REPOSITORY
NEXUS_BACKUP_REST_USERNAME
NEXUS_BACKUP_REST_PASSWORD
NEXUS_BACKUP_REPOSITORY_CA_B64
NEXUS_BACKUP_REPOSITORY_CA_SHA256
```

`NEXUS_BACKUP_REPOSITORY` uses the configured advertised host/port, not necessarily Tower's local listen port.

Treat the helper output as secret because it contains the REST password. To rotate deliberately:

```sh
nexus-repository-client balder-pc acceptance --rotate
```

A rotation requires workstation reprovisioning.

## 9. Enroll and provision Windows

In Nexus **Workstations**, choose **Add workstation** and obtain the generated elevated PowerShell command.

On Windows, open elevated PowerShell, paste the five Repository environment lines from `nexus-repository-client`, then add a separate Restic encryption password:

```powershell
$env:NEXUS_BACKUP_RESTIC_PASSWORD='<dedicated Restic encryption password>'
```

For acceptance use a new disposable password, never a PCWatch/production key. Run the Nexus-generated install command in the **same** elevated PowerShell session.

The installer must verify bundled binaries, exchange the one-shot enrollment credential, SHA-pin the supplied Repository CA, store secrets only below `%ProgramData%\NexusBackup` with SYSTEM/Admin ACL, explicitly initialize/verify the exact namespace, set remote runtime `autoInit=false`, and run `NexusBackupWorkstation` as SYSTEM.

Normal runtime **never** initializes a remote repository after auth, TLS, network or repository probe failure.

## 10. Installer/control transport boundary

Direct-LAN installation may still use plain LAN HTTP during beta and therefore assumes a trusted LAN/Unraid host during installation.

For an off-LAN workstation, use the explicit HTTPS Control/public URL described above. Repository traffic is separately TLS protected using the pinned CA from the local helper output.

Do not expose or paste `C:\ProgramData\NexusBackup\workstation.json`; it contains secrets.

## 11. Secret/recovery boundary before production

Two independent secret classes exist:

1. **REST transport credential** — stored under `/config/repository` and workstation local config.
2. **Restic encryption password** — decrypts backup contents; workstation-local and never known by Control/Repository.

For isolated acceptance these can be disposable. **Do not perform production cutover** until off-host recovery of workstation encryption keys and `/config/repository` has been implemented and tested.

## 12. Emergency bundle

Create and verify the Nexus emergency bundle according to `docs/emergency-recovery.md` after local auth, Agent config/secrets and enrollment are trusted.

## 13. Ready for isolated acceptance

A fresh installation is ready to enter `docs/acceptance-test.md` only when:

- exact image version/digest is recorded and acceptance runs the immutable digest rather than `:latest`;
- local admin login works;
- Agent is online with explicit/inert-safe config;
- Repository TLS service is running on the intended `/backup/workstations` tree;
- configured Repository endpoint is reachable from the workstation network being tested;
- Internet mode exposes only the Repository port directly and append-only is enabled unless explicitly waived;
- off-LAN workstations also have a working HTTPS Control path that does not carry backup payloads;
- workstation is provisioned with a dedicated Repository principal and disposable acceptance encryption password;
- `/data` is narrow/read-only and does not contain `/backup` or `/restore` through the host mapping;
- container has no `SYS_ADMIN`/`/dev/fuse` unless deliberately required;
- emergency bundle has been created and verified;
- PCWatch-backup and Copyarr remain unchanged.

If any item is uncertain, stop before acceptance rather than testing against production data or repositories.
