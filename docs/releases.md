# Releases and container versioning

Nexus Backup publishes the self-contained product as two coordinated container images:

- `ghcr.io/swamp2k/nexus-backup-control`
- `ghcr.io/swamp2k/nexus-backup-agent`

Both images from one release always receive the same product version and Git revision.

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

The immutable SemVer tags provide rollback and reproducibility. `latest` is the update channel intended for the future Unraid templates.

## Runtime and OCI metadata

Release builds receive:

- `NEXUS_BACKUP_VERSION=<semver>`
- `NEXUS_BACKUP_REVISION=<git sha>`
- agent `NEXUS_BACKUP_AGENT_VERSION=<semver>`
- OCI `org.opencontainers.image.version`
- OCI `org.opencontainers.image.revision`
- OCI `org.opencontainers.image.source`

The bundled agent therefore reports the release version through its normal heartbeat, which is already shown on the Nexus Backup Agent page. Local source builds default to `dev` / `unknown` unless build arguments are supplied.

## Release procedure

1. Ensure `main` CI is green.
2. Create and push an annotated or lightweight tag such as `v0.7.0` at the desired main commit.
3. `.github/workflows/release-images.yml` validates the tag, builds both images from the same commit and pushes them to GHCR.
4. Confirm both packages contain the immutable version tag and, for a stable release, `latest`.

Do not repoint an existing immutable SemVer tag to different code. If a release needs a fix, publish a new patch version.

## GHCR visibility

GitHub Container Registry packages are private on first publication unless their visibility is changed. Before using the images as anonymous Unraid update channels, make both Nexus Backup packages public in GitHub Package Settings.

The OCI source label links the packages back to this repository, but package visibility remains an explicit release/deployment setting.

## Future Unraid integration

The future Unraid templates should track `:latest`, not a pinned SemVer tag, so Docker Manager can compare the registry image digest and surface an available update. The running release remains identifiable through OCI metadata and the agent heartbeat.

Users who intentionally want to pin a release can replace `latest` with an immutable tag such as `0.7.0`.

Nexus Backup uses two containers, so the final Unraid packaging must keep control and agent on the same release channel/version. Do not independently auto-update only one half of the product without compatibility handling.
