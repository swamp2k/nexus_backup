# Home mode

Nexus Backup is Home-first by default. The normal trust boundary is the home LAN plus the Unraid host that owns `/backup`.

The goal is a short path from enrollment to useful redundant data:

```text
Install workstation agent
  -> scan drives once
  -> choose folders
  -> schedule/run backup
  -> restore to safe staging when needed
```

## Default workstation Repository

With **Settings -> Workstation Repository -> Home / trusted LAN** selected, Nexus runs the bundled Restic REST server as plain HTTP without Repository authentication or TLS. Each workstation receives an automatic repository path derived from its Nexus device id:

```text
rest:http://<nexus-lan-host>:8000/<workstation-id>
```

No per-workstation REST username/password, CA certificate, certificate pinning or manual repository provisioning is required.

The workstation uses Restic with `--insecure-no-password`. Restic still provides its repository format, snapshots, deduplication, compression and integrity checking, but there is no secret Restic password/recovery key to preserve. Nexus does not inherit ambient `RESTIC_PASSWORD`, `RESTIC_PASSWORD_FILE` or `RESTIC_PASSWORD_COMMAND` values into Home-mode jobs.

The first backup may initialize the workstation's Home repository automatically. Remote/encrypted repositories retain the existing fail-closed behavior and are never runtime-initialized just because an auth/TLS/network probe failed.

## Windows agent

The agent remains an AtStartup Scheduled Task running as SYSTEM so it can operate without an interactive login and can use Windows/VSS backup functionality.

Configuration remains under:

```text
C:\ProgramData\NexusBackup
```

Home mode deliberately uses ordinary ProgramData inheritance rather than stripping ACL inheritance and turning the folder into a special hidden secret store. Repair/update also resets the older beta ACL treatment.

The installer discovers Home Repository settings from Nexus using the workstation's durable device identity and writes the resulting local configuration automatically.

## Data-safety behavior that remains

Home mode removes hostile-network ceremony; it does not remove safeguards against accidental destructive behavior. In particular:

- workstation source discovery remains bounded and run-once/cached;
- backup payload still travels directly between workstation and Repository, not through the Control API or cloud;
- restore remains staging-first rather than replacing live files in place;
- write restore keeps `--overwrite never` and never uses `--delete`;
- existing staging targets are refused;
- interrupted write restores are not automatically retried;
- installer payload checksums remain verified.

## Remote / Internet mode

Remote mode remains available as an advanced opt-in for workstations reaching the Repository across an untrusted network. It retains the existing hardened transport model:

- HTTPS with TLS 1.3 minimum;
- bcrypt Repository authentication;
- private Repository namespaces;
- locally pinned Repository CA material on the workstation;
- optional/default append-only protection for direct Internet exposure.

Switching the Repository policy to Remote mode does not silently rewrite an existing workstation's local storage credentials. Remote onboarding/provisioning remains an explicit operation.

## Operator responsibility

Home mode intentionally assumes the LAN and Unraid server are trusted. Anyone who can reach the Home Repository endpoint can access the Restic repository bytes. Protect network access and Unraid according to the needs of the household; Nexus does not add a second credential/TLS perimeter in Home mode.
