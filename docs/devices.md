# Managed devices and PCWatch integration

M6 starts by separating two concepts that must not be conflated:

- a **Nexus Backup execution agent** owns storage credentials and performs backup/restore/transfer jobs;
- a **managed device** is a trusted PCWatch or other client that reports identity, version and bounded capabilities.

A managed device does not receive shell commands, storage credentials or arbitrary filesystem paths from this API. Adding job delegation later requires an explicit capability and a separately constrained job contract.

## Enrollment

An authenticated local admin creates a device from the **Devices** page or:

```http
POST /v1/local/devices
Content-Type: application/json

{"name":"Balder PC","kind":"pcwatch"}
```

The response contains a bearer token once. Nexus stores only its SHA-256 hash. Losing the token requires rotation; Nexus cannot recover the original secret.

Device tokens can be disabled or rotated from the local dashboard. Rotation immediately invalidates the previous token.

## Reporting

Devices report to:

```http
POST /v1/device/report
Authorization: Bearer <device token>
Content-Type: application/json
```

The initial report schema deliberately accepts the useful metadata shape already emitted by the PCWatch backup agent:

```json
{
  "version": "0.2.2",
  "hostname": "optional-hostname",
  "platform": "optional-platform",
  "capabilities": [
    "rclone.v1",
    "rclone-mount.v1",
    "gdocs-export.v1",
    "restic-local.v1"
  ],
  "remotes": ["gdrive:", "seedbox:"],
  "runtime_settings": {
    "rclone": {
      "tpslimit": 8,
      "max_transfer": "850G"
    }
  }
}
```

`runtime_settings` is accepted only as a small object for forward compatibility with PCWatch but is **not persisted** in this first slice. This prevents a future or misconfigured client from accidentally turning arbitrary settings into a durable metadata channel.

Persisted report fields are bounded:

- version: 64 characters
- hostname: 128 characters
- platform: 64 characters
- capabilities: at most 32 strings, 64 characters each
- remote names: at most 64 strings, 128 characters each

Remote **names** are metadata only. rclone config contents, OAuth material, Restic passwords and source data never belong in a device report.

A successful report returns `nextReportSeconds: 60`. The dashboard considers an enabled device online when it has reported within the last three minutes.

## PCWatch migration boundary

The current PCWatch backup agent already follows the right security model: it keeps provider credentials and the Restic password local, reports capabilities/status to its Worker and accepts only a constrained backup job schema.

The report payload is therefore intentionally compatible in spirit and field naming. However, this first M6 slice does **not** implement PCWatch's existing `/api/backup-agent/jobs/pending`, progress or result endpoints. Pointing the old agent at Nexus without an adapter would cause its job polling to fail.

The next integration slice can either:

1. add a small Nexus mode to the PCWatch agent, using `/v1/device/report` and a new constrained Nexus device-job API; or
2. retire PCWatch's backup execution path and use PCWatch only as a device/status source while Nexus' local execution agent owns all backup work.

Whichever route is chosen, local-first remains authoritative and backup bytes do not traverse PCWatch, Cloudflare or the Nexus control plane.

## Example report

```sh
curl -X POST http://nexus-backup.local:8787/v1/device/report \
  -H 'Authorization: Bearer nxbdev_...' \
  -H 'Content-Type: application/json' \
  --data '{"version":"0.2.2","capabilities":["rclone.v1"],"remotes":["gdrive:"]}'
```

The token shown here is illustrative only. Treat a real device token as a credential.
