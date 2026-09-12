# M2 control plane

## Runtime contract

The control plane is written as a Cloudflare Worker-compatible module but is intentionally not tied to a committed Worker deployment yet.

Environment bindings:

```text
DB                     D1 database binding
CONTROL_PLANE_TOKEN    secret used by Nexus/admin control calls
DEFAULT_LEASE_TTL_MS   optional lease TTL, defaults to 60000
```

The concrete D1 database name/id and Worker deployment target are deployment choices, not source-code defaults.

## Authentication

### Control calls

Use:

```text
Authorization: Bearer <CONTROL_PLANE_TOKEN>
```

Control calls may register/rotate agents, create jobs and read job history.

### Agent calls

Agents use their individually registered bearer token. Registration stores only its SHA-256 hash. The API resolves agent identity from the token and ignores client-side identity claims.

Agent tokens should be generated as long random secrets. The registration API currently enforces a minimum length of 32 characters.

## API

### Health

```text
GET /healthz
```

### Control-plane routes

```text
POST /v1/agents
POST /v1/jobs
GET  /v1/jobs/:jobId
GET  /v1/jobs/:jobId/events
```

Example job creation body:

```json
{
  "operationKey": "nightly:gdrive:2026-09-12",
  "type": "backup",
  "payload": {
    "sourceId": "gdrive-main",
    "repositoryId": "repo-gdrive-unraid"
  }
}
```

`operationKey` is unique and makes repeated scheduler/API submissions idempotent.

### Agent routes

```text
POST /v1/agent/claim
POST /v1/agent/jobs/:jobId/heartbeat
POST /v1/agent/jobs/:jobId/transition
```

`claim` returns `204 No Content` when no job is available. A successful claim returns the job, an opaque lease token and the effective lease TTL.

## Recovery

The Worker module exposes a scheduled handler that scans expired, non-terminal leases and requeues them using compare-and-swap revisions. A future Wrangler deployment should configure an appropriate cron trigger; no cadence is hard-coded in the repository.

## Migration

`migrations/0001_control_plane.sql` creates:

- `backup_jobs`
- `backup_job_events`
- `backup_agents`
- claim/recovery/event lookup indexes

Apply this migration to the selected D1 database before enabling agents. The repository deliberately does not contain a guessed database id or database name.

## Security boundaries for M3+

Do not move rclone configs, restic passwords, SSH keys or cloud provider secrets into D1 merely because the control plane exists. D1 should store metadata and credential references; the actual credentials should remain on the responsible local agent unless a later design explicitly requires otherwise.
