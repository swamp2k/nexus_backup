# Flat-file storage model

This document is the canonical storage direction for Nexus Backup after the Restic/Repository-server prototype.

## Product boundary

Nexus Backup is a LAN-first, self-contained home backup and transfer appliance.

- `Backup repository root` remains the single Unraid/container root for Nexus-managed backup data (`/backup` inside the container).
- Restic is not the storage backend.
- There is no Home/Remote, LAN/WAN or Internet Repository mode in the product.
- Nexus does not expose a separate Repository server or Repository transport credentials.
- The generic **Devices** product concept is removed. PCs live under **Workstations**.
- The generic **Agent** product concept is removed. Local execution is an implementation detail of the Nexus appliance.
- A Windows workstation still requires its small Nexus workstation service/client so Nexus can read that PC's local filesystem. It is part of the Workstation feature, not a separately managed Agent.
- Existing **Sources** and **Destinations** remain during the transition.

## Repository definitions

The **Repositories** page manages logical storage repositories. Each repository is a normal directory below `/backup`.

A repository has:

- stable ID
- display name
- path relative to `/backup`

Creating a repository with only a name creates:

```text
/backup/<repository-name>/
```

The create dialog also offers a folder browser rooted at `/backup`. The browser may navigate and create directories, but may never escape `/backup`. Selecting a folder stores its relative path as the repository location.

No encryption key, Restic password, TLS certificate, endpoint host, append-only flag or transport credential belongs to a flat-file repository definition.

## Workstations

Each workstation selects exactly one repository for backup storage.

The workstation target is derived by Nexus and is not entered as a raw path:

```text
/backup/<repository-path>/<workstation-name>/
```

Workstation names used as directory names are normalized and validated by Nexus. The workstation client never chooses an arbitrary server-side destination path.

The backup payload is ordinary files and directories. The first implementation uses a browsable current file tree and safe replacement semantics; source deletions are not propagated destructively by default. Version-history/retention can be layered onto the flat tree without changing the repository abstraction.

## Transfers

Transfer rules select a repository from the same repository list.

Their destination root is derived as:

```text
/backup/<repository-path>/<transfer-job-name>/
```

The transfer rule does not define an arbitrary local destination path once migrated to this model. Existing remote/source endpoint configuration remains usable for discovering and reading source data.

## UI

Primary navigation after the transition:

- Overview
- Jobs
- Plans
- Transfers
- Workstations
- Sources
- Destinations
- Repositories
- Settings

Removed:

- Devices
- Agent

The Repository page provides:

- repository list
- **New repository** button
- name field
- optional folder browser below `Backup repository root`
- create-folder action inside that browser

## Safety rules

- All repository and generated workload paths are constrained below `/backup`.
- No `..` traversal, absolute arbitrary destination, or symlink escape is accepted.
- File writes use temporary/staging names and commit only after successful transfer/verification.
- Nexus does not automatically delete destination backup files merely because a workstation source disappears.
- Restore remains staging-first rather than overwriting workstation files in place.

## Migration sequence

1. Add flat repository definitions, `/backup` folder browser and repository UI.
2. Remove Devices and Agent from the product UI; remove LAN/WAN Repository settings.
3. Make Workstations choose a repository and derive `<repository>/<workstation-name>`.
4. Move workstation backup execution from Restic snapshots to flat-file copy/update.
5. Make Transfers choose the same repository definitions and derive `<repository>/<transfer-name>`.
6. Remove the Restic Repository server, Restic workstation bundle, port 8000 and obsolete Restic recovery/inventory surfaces.
7. Collapse the generic local execution-agent implementation behind Nexus itself while preserving Sources/Destinations until their final design is proven.
