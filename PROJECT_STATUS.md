# Nexus Backup — Project Status

_Last updated: 2026-09-18_  
_Main reference: `2541477f023aead5ae657e434bbc876f27189111`_

This file is the short operational status of the project: what Nexus Backup is now, what is already in place, what has been physically verified, and what still needs work before the current beta can be considered solid.

## Product direction

Nexus Backup is intentionally a simple, self-hosted backup appliance for home / homelab use.

The product principle is:

> **Understandable, browsable, boring, reliable.**

Backup data is stored as ordinary files below `/backup`. A repository is just a named folder. A workstation, transfer, or receiver writes into a predictable subfolder that can be inspected without Nexus Backup itself.

Expected workstation layout:

```text
/backup/
  <repository>/
    <workstation>/
      Documents/
      Pictures/
      ...
```

There is no Restic repository format, snapshot database, recovery key, retention/prune workflow, or other opaque backup storage layer in the current product.

## Current architecture

### Appliance

- One Docker / Unraid-first application.
- SQLite stores configuration, scheduling, identities, status, and job metadata.
- `/backup` is the only backup storage root.
- Repositories are folders below `/backup` with stable IDs and safe relative paths.
- Repository path handling rejects traversal and symlink escape outside the backup root.
- Local authentication protects the dashboard/API.
- Optional **Remote connection** setting adds an application-level HTTP Host gate.
- Local LAN access remains available when Remote connection is disabled.

### Workstations

- Windows workstations are created only from the **Workstations** page.
- Enrollment selects the destination repository immediately.
- The Windows client uses a durable device bearer token.
- Backups upload directly through `/v1/device/workstation/files`.
- Selected source hierarchy is preserved below the workstation destination folder.
- Existing files are replaced only after the new upload has completed.
- Missing source files are **not** mirrored as deletions.
- Source scanning / TreeSize is run explicitly and the latest result is cached by Nexus.
- Workstation cards now use the server-side repository policy as the authoritative assignment.
- Workstations can be deleted from the Workstations page; configuration/history/receiver identity is removed while existing backup files remain untouched.

### Receivers

Bundled SFTPGo provides the protocol engine for:

- SFTP
- FTP
- WebDAV

Nexus owns the receiver-user configuration and repository rooting.

Manual receiver users have:

- username
- generated or supplied password
- repository
- optional subfolder
- enable / disable
- password reset
- delete

Users are restricted to their assigned repository root.

### Transfers

Transfers write ordinary files into a selected Nexus repository.

Existing transfer work retained during the product reset includes:

- repository-targeted local execution
- rclone-based source handling where applicable
- rTorrent completion gates / grouping
- staging and verification safeguards
- cleanup handling
- stable transfer identity

## Completed major reset

The flat-file product reset is complete in main.

Important removed product concepts:

- Restic
- rest-server
- generic Agent product/UI
- Devices page
- Plans page
- WAN/LAN mode
- repository password / recovery-key flows
- Restic snapshots / retention / forget / prune UX

Legacy database migrations remain for safe upgrades, but active product behavior follows the flat-file model.

## Recently fixed

### PR #54 — dashboard and repository UI regressions

Fixed issues found during physical beta testing:

- Settings refresh no longer destroys focused form inputs every five seconds.
- Allowed hostname can be edited without the page resetting the field.
- Settings checkbox sizing is scoped correctly.
- Settings status labels and values no longer run together.
- Repository folder browser no longer inherits the global wide-table layout.
- Repository modal keeps the Save action reachable.
- New Repository Save uses robust form field lookup.

### PR #55 — workstation UX and repository state

Fixed issues found during physical beta testing:

- Workstation cards consume less vertical space.
- A newly enrolled workstation no longer depends on the legacy client-reported `repositoryConfigured` flag to determine whether a repository is assigned.
- Workstation polling uses the server-side policy repository assignment.
- Workstations can be deleted explicitly from the Workstations page.
- Deleting a workstation removes enrollment metadata, policy/run data, and workstation receiver identity but preserves backup files.

## Physical beta status

### Appliance

Physically observed on Unraid during the flat-file beta cycle:

- container starts and dashboard is usable
- repository creation flow is present
- Workstations page is present
- Settings page is present
- first UI regressions around refresh/layout were identified from the real appliance

The latest fixes in PR #54 and PR #55 still need to be re-accepted on the physically updated Unraid container after the corresponding beta image is installed.

### Windows workstation client

The Windows client had previously demonstrated:

- native drive discovery
- TreeSize/source scanning
- live scan progress
- saved source-tree browsing

The current post-flat-file-reset workstation client still needs a clean physical acceptance pass against the current appliance build.

## What still needs to be verified

These are the highest-priority acceptance checks, not new architecture work.

### 1. Repository workflow

Physically verify:

- create repository
- Browse `/backup`
- create/select folder
- Save repository
- repository appears immediately after creation
- no horizontal modal overflow
- repository path on disk matches the selected folder

### 2. Settings workflow

Physically verify:

- type into Allowed hostname for longer than one dashboard refresh interval
- input keeps focus and content
- save Remote connection settings
- checkbox has normal size
- status rows remain compact/readable

### 3. Workstation enrollment

Physically verify:

- add workstation with repository selected
- workstation immediately shows that repository assignment
- no false “Repository not configured”
- installer command is generated
- new client installs / repairs successfully
- workstation comes online with current build/revision

### 4. Workstation sources

Physically verify:

- local drives are listed
- TreeSize scan starts once
- live progress updates
- completed cached tree is displayed
- selected folders persist correctly
- source selection survives collapsed/lazy tree branches

### 5. Actual workstation backup

This is the most important remaining end-to-end proof.

Verify that a real Windows workstation:

1. receives a backup run
2. uploads selected files
3. creates ordinary files under:
   `/backup/<repository>/<workstation>/...`
4. preserves source hierarchy
5. replaces changed files successfully
6. does not delete destination files when source files disappear
7. can run again incrementally without recopying unchanged data unnecessarily

### 6. Workstation deletion

Physically verify:

- Delete is visible and usable
- confirmation is clear
- workstation disappears from Nexus
- its receiver identity is removed
- existing backup folder and files remain untouched

### 7. Receiver protocols

Reconfirm in the beta image:

- SFTP login/upload
- FTP login/upload
- WebDAV login/upload
- receiver user cannot escape assigned repository root
- disabled/deleted receiver account can no longer authenticate

### 8. Transfers

Run at least one real transfer into a repository and verify:

- correct target folder
- normal flat files on disk
- staging/completion behavior
- rerun behavior
- no unintended deletion

## Known technical debt / cleanup

These items are lower priority than proving the real backup path.

- Some legacy schema/history remains intentionally for upgrade safety.
- Internal `managed_devices` remains as workstation identity infrastructure even though the Devices product surface is gone.
- Some workstation status fields still originate from the older storage model and can be simplified further now that policy repository assignment is authoritative.
- UI code still contains sidecar-style modules layered onto the original dashboard; a later cleanup could consolidate routing/render ownership once behavior is stable.
- CSS should continue to be audited for generic selectors leaking into feature-specific views.
- Transfer styling uses older shared variables/components in places and deserves a visual pass after core acceptance.
- Tests are strong at service/static-contract level, but browser-level end-to-end UI coverage is still limited.

## Near-term plan

Recommended order:

1. publish/install latest beta after main CI
2. physically re-test PR #54 fixes
3. physically re-test PR #55 workstation changes
4. install/update the current Windows workstation client
5. complete one real end-to-end workstation backup
6. verify incremental second run and no-delete behavior
7. verify workstation deletion preserves files
8. exercise one manual receiver user
9. exercise one real transfer
10. fix only regressions found during those acceptance tests before adding larger features

## Not planned right now

Do not reintroduce complexity unless a real use case requires it.

Currently out of scope:

- Restic or another opaque repository format
- snapshots/version history
- retention/prune policies
- backup encryption/recovery-key UX
- enterprise role/RBAC systems
- separate SFTPGo administration
- WAN/LAN operating modes
- automatic destructive mirroring
- cloud dependency for normal backup operation

## Definition of a solid beta

The current architecture is ready to be called a solid beta when a clean Unraid installation can repeatedly demonstrate:

- repository creation works
- workstation enrollment works
- Windows client installs/updates
- source selection works
- scheduled/manual backup writes ordinary browsable files
- repeat backup is incremental
- source deletion does not delete the backed-up copy
- workstation deletion does not delete backup data
- SFTP/FTP/WebDAV receiver isolation works
- a repository-targeted transfer works
- restart/update of the container keeps configuration and backup data intact

Until those are physically demonstrated on the current image, the focus should stay on acceptance and regression fixes rather than expanding the feature set.
