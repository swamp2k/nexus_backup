# Nexus Backup

Nexus Backup is the backup and transfer engine for Nexus. It is designed around a small control plane and local agents that move data directly between sources and destinations.

## Status

M1 foundation is implemented:

- shared job model and state machine
- idempotent operation keys
- lease ownership and heartbeat semantics
- expired-lease recovery
- durable event interface
- testable agent runner
- storage abstraction ready for D1/SQL

No backup payloads pass through Nexus itself.

## Repository layout

```text
packages/core   Domain model, state machine, leases and repository contracts
apps/agent      Agent runtime skeleton
docs            Architecture and milestone notes
```

## Development

Requires Node.js 22+ and TypeScript 5.8+.

```bash
npm install
npm test
npm run typecheck
```

## Roadmap

1. M1 - Core engine and agent lifecycle
2. M2 - Control-plane API, D1 persistence and agent authentication
3. M3 - rclone + restic pipeline
4. M4 - Nexus UI
5. M5 - transfer engine / Copyarr capabilities
6. M6 - device / PCWatch integration
7. M7 - restore
8. M8 - recovery torture testing
9. M9 - architecture/security review

See `docs/architecture.md` for the invariants that later milestones must preserve.
