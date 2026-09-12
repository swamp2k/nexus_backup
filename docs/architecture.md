# Nexus Backup architecture

## Boundary

Nexus Backup is an orchestration platform. The control plane stores metadata, schedules, job state, events and policy. Agents hold storage credentials and move data directly between sources and destinations.

```text
Nexus control plane
      |
      | jobs / leases / events
      v
Nexus Backup Agent ---- source
      |
      +---------------- destination
```

Backup payloads must not traverse the control plane.

## M1 invariants

1. A job is idempotently created by `operationKey`.
2. At most one live lease owns a job.
3. Persistent repositories must implement `tryAcquireLease` atomically.
4. Lease ownership is proven by both `agentId` and an opaque lease token.
5. Agents renew leases while work is active.
6. Expired non-terminal jobs become `interrupted`, then return to `queued` for recovery.
7. Every state-changing control-plane action emits a durable event.
8. Terminal jobs cannot return to an active state.

## Job lifecycle

```text
queued -> leased -> preparing -> running -> finalizing -> completed
                              |       |          |
                              |       |          +-> partial / failed / interrupted
                              |       +------------> partial / failed / interrupted / cancelled
                              +--------------------> failed / partial / interrupted / cancelled

interrupted -> queued -> leased ...
```

`partial` is terminal and intentionally distinct from `failed`. This is important for tools such as restic where an otherwise useful backup may complete while some files were unreadable.

## Leases

A lease contains:

- agent id
- opaque lease token
- acquisition time
- heartbeat time
- expiry time

A D1/SQL implementation must acquire via a conditional update/transaction rather than read-then-write application logic. The in-memory repository exists to validate domain behavior only.

## Agent

The M1 agent is deliberately transport-agnostic. `AgentRunner` knows how to:

- claim one job
- drive lifecycle transitions
- heartbeat the lease
- execute through a `JobExecutor`
- report completed/partial/failed/interrupted

It does not yet know about rclone, restic, VSS or Copyarr. Those become executors/adapters in later milestones.

## Next milestone

M2 should add the first real control-plane adapter and persistence layer, expected to contain:

- D1 schema/migrations
- atomic job claim endpoint
- heartbeat endpoint
- transition/event endpoint
- agent authentication
- stale lease recovery task
- API contract tests
