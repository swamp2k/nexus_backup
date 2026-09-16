NEXUS BACKUP — FLAT-FILE PRODUCT RESET + BUILT-IN RECEIVERS

Repo:
  swamp2k/nexus_backup

Start point:
  main
  verified current main SHA:
  44571ac6465808ef0c82f54a9e9f7023f1677426

IMPORTANT:
Fetch/rebase before starting in case main moved after this handover.
Do NOT work directly on main.
Create a feature branch, run full CI, PR, and merge only when green.

This is a deliberate product simplification. Do not try to preserve the old
Restic/Internet Repository architecture just because it already exists.

============================================================
PRODUCT DIRECTION
============================================================

Nexus Backup is a HOME / LAN-FIRST backup and transfer appliance.

The user explicitly wants to remove the enterprise-ish abstraction layers that
have accumulated.

The new mental model is:

  Backup repository root (/backup)
      |
      +-- Repository A/
      |     +-- swamp/
      |     +-- BalderPC/
      |     +-- Seedbox Transfer/
      |
      +-- Repository B/
            +-- Photos/
            +-- ...

Everything stored by Nexus is ordinary browsable flat files.

No Restic repository format.
No Restic password.
No Restic recovery key.
No Restic REST server.
No LAN/Internet Repository mode.
No Repository TLS/CA/password provisioning.
No append-only Repository mode.

The Unraid mapping currently named:

  "Backup repository root"

must remain the single filesystem root for Nexus-managed backup storage.

Inside the container it is currently:

  /backup

Keep that concept.

============================================================
1. REPOSITORIES BECOME ORDINARY FOLDERS
============================================================

Repurpose the existing Repositories tab completely.

A Repository is now simply a named Nexus storage root backed by a directory
under /backup.

Example:

  repository:
    name: Family PCs
    path: /backup/Family PCs

Do not expose arbitrary host filesystem paths.

Repository paths must remain underneath canonical /backup.
Reject:
  ..
  symlink escapes
  absolute paths outside /backup
  path traversal through URL/API inputs

Repository creation UI:

  [ New repository ]

Modal/form:

  Name: [ Family PCs ]

  Location:
    default: /backup/Family PCs

    [ Browse ]

If the user only enters a name:
  automatically create /backup/<name>

If Browse is used:
  show a filesystem browser rooted at /backup
  allow selecting an existing folder
  allow creating folders from the browser

The browser must never escape /backup.

Repository records should have stable IDs; jobs/workstations reference IDs,
not raw filesystem paths.

Recommended fields:
  id
  name
  relative_path
  created_at
  updated_at

relative_path should be relative to /backup where practical.

Add migration starting at:
  0017_...

Do not destructively remove old tables immediately if doing so risks breaking
upgrades. Old Restic data/schema may remain unused during migration.

============================================================
2. WORKSTATIONS USE A SELECTED REPOSITORY
============================================================

A workstation belongs to a selected Repository.

When creating/editing a workstation, Nexus must allow:

  Repository: [ Family PCs v ]

The actual workstation backup root becomes:

  <repository path>/<workstation name>/

Example:

  /backup/Family PCs/swamp/

Nexus creates this folder automatically.

Workstation names/folder names must be filesystem safe.
Preserve human-readable names where possible.
Handle collisions explicitly rather than silently sharing folders.

IMPORTANT:
The Windows workstation helper/client survives.

When the user says "Agent concept is dropped", this means:
  - remove the generic local Nexus Agent product concept
  - remove the Agent page
  - remove the separate local Agent service/config/token machinery
  - Nexus itself executes its local work

It does NOT mean eliminating the Windows workstation client.
A local Windows process is still needed for:
  - drive discovery
  - TreeSize/source scan
  - reading workstation files
  - scheduled backup work
  - communication with Nexus

Rename workstation-agent -> workstation-client if that is low-risk.
If renaming all paths causes unnecessary churn, internal naming may temporarily
remain, but the product/UI must not expose an "Agent" concept.

Keep the recently landed:
  native Windows drive discovery
  source scan
  live TreeSize progress
  reparse/junction protection
  current build revision reporting

Do not regress PR #52 TreeScan JSON fix.

============================================================
3. FLAT-FILE BACKUP SEMANTICS
============================================================

Replace workstation Restic backup with ordinary file replication.

Initial model should be intentionally boring:

  selected workstation source folders
       ->
  selected Repository/workstation-name/

Preserve directory hierarchy.

Use safe writes:
  upload/copy to temporary file
  flush/close
  atomic rename into final path where possible

Do NOT delete destination files merely because a source disappeared.
No automatic mirror-delete for now.

Changed files may replace their previous copy only after the new copy has
completed successfully.

Incremental detection may use reasonable metadata such as:
  size
  mtime
and hash when needed.

Do not invent another opaque backup format.

The key requirement is:
  if the Nexus database disappeared, the files under /backup are still ordinary
  understandable files.

Restic-specific:
  snapshots
  retention
  forget/prune
  repository check
  Restic integrity state
  password config
must be removed or replaced with truthful flat-file equivalents.

Do not leave UI buttons that secretly still assume Restic.

For this reset, prioritize a reliable current flat-file copy.
Do not build a complex versioning system unless required by existing behavior.

============================================================
4. TRANSFERS USE REPOSITORIES TOO
============================================================

The Transfers page must use the Repository list as its destination storage.

When defining a transfer:

  Destination repository:
    [ Family PCs v ]

Nexus automatically creates a folder named after the transfer rule/job:

  <repository>/<transfer name>/

Example:

  repository = Downloads
  transfer name = Seedbox

  => /backup/Downloads/Seedbox/

Keep existing transfer safety ideas where useful:
  staging
  incomplete-file protection
  stability window
  size verification
  rTorrent readiness
  cleanup safeguards

But local execution is Nexus itself, not a separate generic Agent service.

Sources and Destinations tabs stay for now.
Do not remove them in this refactor.

Existing rclone source/destination integration may therefore remain available.

New transfer destination configuration should reference repositoryId rather
than making the user manage raw target filesystem paths.

Avoid silently destroying existing transfer rules. Add compatibility/migration
where sensible.

============================================================
5. REMOVE DEVICES TAB
============================================================

Delete the Devices tab completely.

The user does not want:
  Devices
  Generic client enrollment
  PCWatch device representation
  Device UI

PCs belong under:
  Workstations

If the current workstation implementation internally depends on the
managed_devices table for identity/token storage, it is acceptable to retain
that table internally temporarily.

But:
  - no Devices navigation item
  - no generic device UI
  - no generic device creation
  - no user-facing "managed device" concept

Workstations should have their own coherent API/product model.

Do not spend time doing a risky database rewrite solely to rename an internal
table.

============================================================
6. REMOVE THE LOCAL GENERIC AGENT
============================================================

Current appliance starts:
  Control
  Agent
  Repository

New appliance should conceptually be:

  Nexus Backup application
  + transfer receiver service(s)

Nexus Backup itself handles:
  local filesystem actions
  transfer scheduling
  copy jobs
  workstation orchestration
  repositories
  UI/API

Remove the separate appliance Agent lifecycle where feasible:

  apps/agent
  agent token exchange
  Agent nav page
  NEXUS_BACKUP_AGENT_ID
  /config/agent product configuration
  "waiting for Control agent token"
  separate agent process startup

Move/integrate the local execution needed by Transfers/Sources/Destinations into
the local Nexus process/runtime.

Do this cleanly rather than merely hiding the Agent tab while still requiring
an externally modeled "local agent".

============================================================
7. REMOVE RESTIC / REST-SERVER ARCHITECTURE
============================================================

Delete/deprecate the old workstation Repository service:

  rest-server
  repository/docker-entrypoint.sh
  repository/client.sh
  repository/settings.sh

Remove Restic from workstation installer.

Remove the Windows Restic download/build stage.

Remove workstation config fields that only exist for Restic:
  repository URL
  passwordFile
  insecureNoPassword
  autoInit
  restUsername
  restPassword
  caCertPath
etc.

Remove container settings/envs such as:

  NEXUS_BACKUP_REPOSITORY_EXPOSURE
  NEXUS_BACKUP_REPOSITORY_HOST
  NEXUS_BACKUP_REPOSITORY_PORT
  NEXUS_BACKUP_REPOSITORY_ENDPOINT_PORT
  NEXUS_BACKUP_REPOSITORY_APPEND_ONLY
  NEXUS_BACKUP_REPOSITORY_INITIAL_USER

Remove old Home/Internet Repository mode tests/docs.

Do NOT fix the currently broken Restic "Needs storage setup" chain.
That architecture is being retired.

============================================================
8. BUILT-IN TRANSFER RECEIVERS
============================================================

Nexus Backup should provide its own incoming file-transfer endpoints.

Required protocols:

  SFTP
  FTP
  WebDAV

These are for workstation backups AND other equipment/software that needs to
drop files into Nexus.

Strong implementation preference:

Do NOT hand-roll three protocol implementations if avoidable.

Evaluate bundling SFTPGo inside the Nexus single-container appliance.
It is a good architectural fit because it provides:
  - SFTP
  - FTP
  - WebDAV
  - per-user filesystem roots
  - password authentication
  - mature server implementations

If using SFTPGo:
  - pin/checksum the binary/version in Docker build
  - treat it as an internal Nexus receiver engine
  - Nexus owns its configuration/users
  - users should not need to administer SFTPGo separately
  - preserve one-container Unraid deployment

If SFTPGo is unsuitable, use mature protocol libraries.
Do not implement raw FTP/SFTP/WebDAV protocol parsers manually.

rclone serve is only acceptable if it can enforce the required per-user
filesystem isolation cleanly. Do not give every user access to all repositories.

Suggested non-conflicting LAN defaults:
  SFTP: 2222
  FTP: 2121
  FTP passive range: choose a small documented range
  WebDAV: preferably integrated/routed through Nexus HTTP if practical

Because Unraid template currently uses Network=host, these services can bind
directly without Docker port mapping.

============================================================
9. RECEIVER USER MODEL
============================================================

Add a Nexus-administered receiver-user model.

Workstation enrollment automatically creates a receiver identity:

  username = workstation name
  password = cryptographically random 20+ character password

Example:

  swamp : <random 20+ character password>

If workstation names contain invalid username characters:
  normalize predictably and show the actual username in UI.

Never use a weak deterministic password.

Store only a secure password hash server-side where possible.

The clear password should be delivered to the workstation during setup and
stored in the workstation's local ProgramData config.

Prefer not to embed the permanent receiver password directly in the visible
one-line installer command.

Better flow:

  one-time enrollment token
      ->
  installer authenticates once
      ->
  Nexus returns workstation identity + receiver credentials
      ->
  installer stores them locally

Each workstation receiver account should be rooted/chrooted to:

  <selected repository>/<workstation folder>/

It must not be able to browse another repository or workstation directory.

Use SFTP as the default workstation backup transport unless implementation
facts make WebDAV clearly simpler/reliable.

FTP/WebDAV remain available for compatibility/manual clients.

============================================================
10. MANUAL RECEIVER USERS
============================================================

Add a UI section to administer non-workstation receiver users.

Good location:
  Repositories -> Receiver access

or Settings if that fits the UI better.

User should be able to:

  Create user
  Username
  Generate/set password
  Select Repository
  Optionally choose/create a subfolder
  Enable/disable
  Reset password
  Delete

Example:

  username: camera
  repository: Family
  folder: Camera Uploads

Result:

  /backup/Family/Camera Uploads/

That user must only see that root.

Show connection information for:
  SFTP
  FTP
  WebDAV

Do not expose stored password after creation/reset unless absolutely necessary.

============================================================
11. REMOTE CONNECTION SETTING
============================================================

Remove the old LAN/Internet Repository mode concept.

Everything is considered LAN/local by default.

Add application settings:

  Remote connection
    Enabled: on/off
    Allowed hostname: nb.jeppesen.cc

Hostname must be editable.

Default:
  remote connection disabled

When enabled:
  remote HTTP/dashboard/API/WebDAV requests should only be accepted for the
  exact configured hostname.

Example:
  nb.jeppesen.cc

No wildcard by default.

LAN access by local IP/hostname must continue working.

Implement this in the application, not as a required container environment
variable.

Validate hostname carefully.

Prefer the actual HTTP Host authority presented to Nexus.
Do not blindly trust arbitrary X-Forwarded-* headers.

Document clearly:
  this is an application-level hostname gate, NOT a firewall.

FTP and SFTP do not carry an HTTP Host header, so this setting cannot enforce a
hostname for those protocols.

FTP/SFTP are LAN receiver services unless the user deliberately exposes/routes
their ports externally.

The user has explicitly said:
  if WAN exposure is needed, they will arrange that externally.

Do not rebuild the old WAN Repository security stack.

============================================================
12. SETTINGS / UNRAID TEMPLATE
============================================================

Keep:

  Appdata
  Backup source root (/data)
  Backup repository root (/backup)
  Restore staging root (/restore)
  Sources/Destinations related mappings needed by existing features

Remove old Restic Repository exposure variables.

Remove Agent ID.

The current "Transfer destination root" /downloads mapping may remain during
compatibility migration if existing Sources/Destinations/transfer code still
needs it, but new Transfers should target repository IDs under /backup.

Update the Unraid Overview text to describe the new flat-file product.

No wording about:
  Restic
  Internet Repository
  TLS Repository endpoint
  append-only Rest server

============================================================
13. UI TARGET
============================================================

Primary navigation after reset should approximately be:

  Overview
  Jobs
  Plans        (keep if still meaningful)
  Transfers
  Workstations
  Sources
  Destinations
  Repositories
  Settings

REMOVE:
  Devices
  Agent

Repositories is no longer "Restic repositories".
It is ordinary managed backup storage.

Workstation card should show:
  selected Repository
  destination folder
  online status
  sources
  schedule
  current/last backup
  client revision

No "Needs storage setup / Configure workstation.json" Restic language.

============================================================
14. PATH SAFETY
============================================================

This remains important even though enterprise hardening is being removed.

For every Nexus-created repository/workstation/transfer/user directory:

  canonicalize filesystem path
  prove it remains below /backup
  reject ../ traversal
  reject symlink escape
  do not blindly concatenate user strings
  use temp/staging writes
  avoid partial final files
  do not automatically delete backup contents

These are data-safety invariants, not enterprise complexity.

============================================================
15. DATABASE / MIGRATION
============================================================

Current migrations end at:
  0016_workstation_source_scan.sql

Start new migrations at:
  0017_...

Likely new concepts:

  repositories
    id
    name
    relative_path
    timestamps

  receiver_users
    id
    username
    password_hash
    repository_id
    relative_subpath
    enabled
    kind (workstation/manual)
    workstation_id nullable
    timestamps

Workstation policy/config:
  add repository_id / destination binding

Transfer rules:
  add destination_repository_id

Do not destroy old schema/data during first migration.
Deprecate old structures first.

============================================================
16. WINDOWS INSTALLER / CLIENT
============================================================

The installer should become much simpler.

Install:
  Nexus workstation client only

Do NOT download Restic.

Config should primarily need:

  Nexus URL
  durable workstation token
  receiver protocol
  receiver host/port
  receiver username
  receiver password
  repository/workstation destination identity
  poll/report timing

Keep:
  SYSTEM scheduled task
  normal ProgramData ACL inheritance
  checksum verification of the downloaded Nexus workstation binary
  update/repair flow
  exact build revision reporting

The workstation client should continue to be self-contained from PCWatch.
PCWatch is optional as a launcher only.

============================================================
17. TESTS / ACCEPTANCE
============================================================

Replace tests that encode the retired architecture.

Add strong tests for:

Repository:
  create by name -> real folder under /backup
  browse folders
  create folder
  reject traversal
  reject symlink escape
  duplicate handling

Workstation:
  enroll
  choose repository
  receiver account created
  random >=20 char credential returned during installer handshake
  correct restricted destination
  source scan still works
  flat-file backup writes real readable files
  interrupted upload does not leave corrupt final target

Transfers:
  choose repository
  transfer name creates destination root
  staged transfer still works
  existing Copyarr protections remain where applicable

Receivers:
  authenticate SFTP
  authenticate FTP
  authenticate WebDAV
  correct user can upload
  wrong password rejected
  user cannot escape assigned root
  user A cannot access user B
  disabled user rejected

Remote connection:
  LAN access remains possible
  remote setting disabled rejects non-local/foreign host usage as designed
  configured hostname accepted
  wrong hostname rejected
  malformed hostname rejected

Container:
  boots without Restic/rest-server
  no local Agent startup/token dependency
  receivers start and stop with appliance
  app remains one-container Unraid deployment

Windows:
  workstation client builds on Windows
  installer parses
  no Restic asset requirement
  update/repair preserves identity and receiver configuration

CI:
  npm test
  typecheck
  Go tests/vet
  Windows client test/build
  complete image smoke test

============================================================
18. REMOVE STALE DOCUMENTATION
============================================================

Docs currently contain a lot of Restic/Internet Repository/M9/M10 assumptions.

Update or retire docs so they do not describe functionality that no longer
exists.

Especially review:
  docs/home-mode.md
  docs/internet-repository-acceptance.md
  docs/repository-inventory.md
  docs/workstations.md
  docs/architecture.md
  docs/fresh-install.md
  docs/acceptance-test.md
  docs/emergency-recovery.md
  docs/security-review-m9.md
  docs/single-container-appliance.md
  docs/devices.md
  docs/agent-execution.md
  docs/unraid-agent.md

Do not spend effort preserving historic terminology in current product docs.

============================================================
19. IMPLEMENTATION STRATEGY
============================================================

This is a large reset.

Recommended branch:
  flat-file-product-reset

Use staged commits even if delivered as one final PR:

  A. flat repository model + UI + path browser
  B. remove Devices / Agent / Restic product concepts
  C. workstation flat-file destination
  D. Transfers -> repository destinations
  E. receiver engine + users
  F. remote hostname setting
  G. container/Unraid cleanup
  H. tests/docs

If it is materially safer, split into two PRs:

  PR A:
    flat repositories
    flat workstation/transfer storage
    remove Restic/Devices/Agent

  PR B:
    SFTP/FTP/WebDAV receiver engine
    receiver users
    remote connection setting

But DO BOTH.
Do not stop after writing a plan unless genuinely blocked.

============================================================
20. CURRENT PHYSICAL CONTEXT / DO NOT CHASE OLD BUGS
============================================================

SWAMP has physically demonstrated:
  workstation client online
  build revision reporting
  drive discovery: C:\ D:\ G:\

The user currently has an older beta workstation revision installed:
  beta · 6e499518

Current main includes the subsequent PR #52 source-scan JSON fix:
  44571ac6465808ef0c82f54a9e9f7023f1677426

Do not spend time repairing:
  old Restic repository-profile
  "Needs storage setup"
  Restic no-password behavior
  Internet Repository mode

Those are intentionally being removed.

The TreeSize/source selection functionality IS still useful and should survive.

============================================================
PRODUCT PRINCIPLE
============================================================

The goal is now:

  understandable
  browsable
  boring
  reliable

A user should be able to stop Nexus Backup, open the Unraid share and see:

  Repository/
    PC/
      Documents/
      Pictures/
      ...

No recovery key.
No opaque repository.
No special tool required to understand where the files are.

Nexus should automate the copying and organization, not make the stored data
mysterious.

Implement that product.
