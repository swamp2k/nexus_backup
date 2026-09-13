# Releases and container versioning

Nexus Backup publishes the self-contained product as two coordinated container images:

- `ghcr.io/swamp2k/nexus-backup-control`
- `ghcr.io/swamp2k/nexus-backup-agent`

Both images from one release always receive the same product version and Git revision.

The control image also contains the matching Windows workstation executable, pinned Restic Windows binary and checksum files used by the local workstation installer. Normal workstation enrollment therefore does **not** depend on a GitHub Release being available or on the target PC having Internet access.

## Version source

Released container versions come from the Git tag, not from `package.json`.

A release tag must be SemVer-shaped:

```text
v0.7.0
v0.7.0-rc.1
```

The tag prefix is removed when creating the container tag. For example, `v0.7.0` publishes:

```text
ghcr.io/swamp2k/nexus-backup-control:0.7.0
ghcr.io/swamp2k/nexus-backup-agent:0.7.0
```

Stable releases also update the mutable `latest` tags:

```text
ghcr.io/swamp2k/nexus-backup-control:latest
ghcr.io/swamp2k/nexus-backup-agent:latest
```

Prereleases never update `latest`.

The immutable SemVer tags provide rollback and reproducibility. `latest` is the update channel intended for the Unraid templates.

## Workstation payload

`Dockerfile.local` cross-builds the Windows workstation agent with the same `NEXUS_BACKUP_VERSION` used by the control image. It also downloads the pinned Restic Windows archive during image build and validates the pinned upstream archive checksum. The final control image carries:

```text
/workstation/nexus-backup-workstation-windows-amd64.exe
/workstation/nexus-backup-workstation-windows-amd64.exe.sha256
/workstation/restic.exe
/workstation/restic.exe.sha256
```

Those HTTP paths are served by the local authenticated gateway as explicit public installer assets. They contain no Nexus credentials. `install.ps1` downloads them from the same local Nexus URL that issued the enrollment command and verifies the shipped SHA-256 files before replacing the local binaries.

The release workflow may additionally publish the workstation executable and its checksum as GitHub Release assets. Those files are useful for distribution/debugging, but are not part of the normal local enrollment dependency chain.

## Runtime and OCI metadata

Release builds receive:

- `NEXUS_BACKUP_VERSION=<semver>`
- `NEXUS_BACKUP_REVISION=<git sha>`
- agent `NEXUS_BACKUP_AGENT_VERSION=<semver>`
- OCI `org.opencontainers.image.version`
- OCI `org.opencontainers.image.revision`
- OCI `org.opencontainers.image.source`

The bundled server-side agent therefore reports the release version through its normal heartbeat, which is already shown on the Nexus Backup Agent page. The Windows workstation agent bundled into the control image is built with the same product version. Local source builds default to `dev` / `unknown` unless build arguments are supplied.

## Release procedure

1. Ensure `main` CI is green.
2. Create and push an annotated or lightweight tag such as `v0.7.0` at the desired main commit.
3. `.github/workflows/release-images.yml` validates the tag, builds both images from the same commit and pushes them to GHCR.
4. The workflow also builds/publishes the Windows workstation executable as a GitHub Release asset.
5. Confirm both packages contain the immutable version tag and, for a stable release, `latest`.

Do not repoint an existing immutable SemVer tag to different code. If a release needs a fix, publish a new patch version.

A release is not required merely to install a workstation from an already-running Nexus control image: the control image itself is the local installer source.

## GHCR visibility

GitHub Container Registry packages are private on first publication unless their visibility is changed. Before using the images as anonymous Unraid update channels, make both Nexus Backup packages public in GitHub Package Settings.

The OCI source label links the packages back to this repository, but package visibility remains an explicit release/deployment setting.

## Unraid integration

The Unraid templates should track `:latest`, not a pinned SemVer tag, so Docker Manager can compare the registry image digest and surface an available update. The running release remains identifiable through OCI metadata and the agent heartbeat.

Users who intentionally want to pin a release can replace `latest` with an immutable tag such as `0.7.0`.

Nexus Backup uses two containers, so the final Unraid packaging must keep control and agent on the same release channel/version. Do not independently auto-update only one half of the product without compatibility handling.
