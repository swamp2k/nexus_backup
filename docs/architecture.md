# Nexus Backup architecture

## Boundary

Nexus Backup is an orchestration platform. The control plane stores metadata, schedules, policy, job state and events. Agents hold storage credentials and move data directly between sources and destinations.

```text
Nexus / control plane
        |
        | jobs, leases, events, policy
        v
Nexus Backup Agent -------- source
        |
        +------------------- destination
```

Backup payloads must not traverse the control plane.

## Core invariants

1. Jobs are idempotently created by `operationKey`.
2. At most one live lease owns a job.
3. Persistent claim operations are atomic; they are never implemented as read-then-write application logic.
4. Every mutable job row has a monotonically increasing `revision`; heartbeat, transition and recovery use compare-and-swap semantics.
5. Lease ownership requires both authenticated agent identity and an opaque per-job lease token.
6. Agent identity comes from the registered bearer token, never from a client-supplied agent id.
7. A persisted job mutation and its durable history event commit in one database transaction.
8. Terminal and interrupted jobs release their lease capability immediately.
9. Expired leases recover through revision-checked mutation so recovery cannot overwrite newer agent activity.
10. Losing lease heartbeats aborts the agent executor signal; executors must honor cancellation.
11. Credentials and storage access remain local to the agent wherever possible.
12. Backup payloads never flow through Nexus/Cloudflare.

## Job lifecycle

```text
queued -> leased -> preparing -> running -> finalizing -> completed
                              |       |          |
                              |       |          +-> partial / failed / interrupted
                              |       +------------> partial / failed / interrupted / cancelled
                              +--------------------> failed / partial / interrupted / cancelled

interrupted -> queued -> leased ...
```

`partial` is terminal and intentionally distinct from `failed`. This matters for tools such as restic where a useful snapshot may be produced even though individual files were unreadable.

## Persistence and concurrency

A job contains a numeric `revision`. Any update based on a previously read row uses the expected revision in the SQL `WHERE` clause. If another heartbeat, transition or recovery already changed the row, the stale writer updates zero rows and surfaces a concurrent-mutation conflict.

Lease claims use a single conditional `UPDATE ... RETURNING` statement. Claim-next selects the oldest eligible job inside that same mutation, so two agents racing to claim cannot both own the same job.

Every state-changing job mutation also writes a `backup_job_events` row. The mutation sets a unique `last_mutation_id`; the corresponding event insert is conditional on that marker and both statements execute in one D1 batch transaction. A failed event insert therefore rolls the job mutation back too.

## Authentication model

Control-plane and agent authentication are separate.

- Nexus/admin callers use `CONTROL_PLANE_TOKEN`.
- Agents receive their own long random bearer token.
- D1 stores only SHA-256 hashes of agent tokens.
- The server resolves the authenticated agent id from the token.
- Lease tokens are generated separately for each claim and prove ownership of one job attempt.

A stolen lease token alone is insufficient because requests must also authenticate as the owning agent.

## Agent runtime

`AgentRunner` is transport-agnostic. It:

- claims one job
- transitions it through preparing/running/finalizing
- maintains the lease heartbeat while the executor is active
- stops heartbeats before final transitions to avoid revision races
- aborts the executor if heartbeat ownership is lost
- reports completed, partial, failed or interrupted state

rclone, restic, VSS and Copyarr-style transfers remain executor/adaptor concerns rather than control-plane concerns.

## Next milestone

M3 adds real payload executors and local runtime configuration:

- rclone source/transport adapter
- restic repository adapter
- process execution with structured progress/events
- cancellation that terminates child processes
- restic exit-code mapping, especially exit code 3 -> `partial`
- local credential references and validation
- first real Google Drive -> restic repository pipeline
