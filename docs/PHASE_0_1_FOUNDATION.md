# Phase 0–1 Mint Execution Foundation

Phase 0–1 replaces mutable, session-driven mint configuration with a fail-closed execution foundation.

## Invariants

- `POST /api/collections` creates an inactive, unverified draft. Request data cannot set `verified` or activate support.
- Every new mint job stores a canonical definition snapshot, its SHA-256 hash, and the certified definition-version ID.
- Execution uses the job snapshot, not later collection edits. A missing or altered pin fails closed.
- `active`, `verified`, and broadcast pause controls remain live so an operator can stop old queued jobs immediately.
- Signed provider payloads are reduced to transaction intent, encrypted with the vault key, integrity-hashed, and persisted before a job may arm.
- Existing config seeds are backfilled as certified active versions by the deploy seed, preserving their current behavior.
- Legacy unsigned pending jobs are pinned during the seed backfill. A partially pinned, already-attempted, or otherwise unsafe legacy job is never guessed into compatibility mode.

## Lifecycle

The persisted lifecycle is `draft -> certified -> active -> retired`. Phase 0–1 intentionally exposes only draft registration; activation remains seed-controlled until the certification service and fork-test gate are implemented in the next phase.

Only one definition can be active for a collection. Drafting an update to a live collection does not mutate its current execution fields.

## Broadcast controls

Project pause:

```http
PATCH /api/collections/:id/controls
X-Support-Admin-Token: ...
Content-Type: application/json

{"projectPaused":true,"reason":"incident review"}
```

Phase pause:

```json
{"phaseId":"allowlist","phasePaused":true,"reason":"proof endpoint changed"}
```

Pending jobs remain pending while paused without consuming retries. An armed job that is paused at final revalidation is aborted rather than broadcast late. Errors include stable codes such as `MINT_PROJECT_PAUSED`, `MINT_PHASE_PAUSED`, and `MINT_DEFINITION_MISMATCH`.

## Deployment

`npm run db:ensure-phase01` applies the idempotent foundation migration. It runs automatically before the web process, worker, and Railway seed. `npm run db:seed` then creates or updates certified versions for the reviewed projects in `config/supported-projects.json`.
