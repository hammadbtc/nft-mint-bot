# Phase 2 — Machine Certification and Atomic Activation

Phase 2 makes mint support a persisted state machine:

```text
draft -> certified -> active -> retired
                 \-> paused (revoked)
```

No API request can jump from draft to active. Certification and activation are separate authenticated transactions.

## Certification invariants

- Evidence is bound to the canonical definition hash, chain, anchored block, exact transaction intent, and deployed source commit.
- A controlled fork/replay RPC must successfully execute the exact transaction with the signing wallet as `from`.
- Every executable adapter phase needs a phase-labeled transaction. The runner invokes the production adapter/compiler and requires exact equality of chain ID, target, calldata, and value before accepting the supplied fork transaction.
- Collection and transaction-target bytecode hashes are captured at the anchored block.
- The runner executes the adapter/phase, negative-path, URL-boundary, restart-recovery, and support-certification suites.
- Evidence is HMAC-attested with `CERTIFICATION_ATTESTATION_KEY`. Handwritten or edited evidence cannot certify.
- Evidence expires after 24 hours; the policy rejects evidence lifetimes longer than seven days.
- Certification records and definition identities are immutable at the database layer. Revocation is one-way.

## Operator flow

1. Register the definition with `POST /api/collections`. It remains inactive and unverified.
2. Build the exact transaction on a controlled fork/replay RPC. The transaction input file contains only public transaction fields—never a private key:

```json
{
  "mode": "fork",
  "contracts": [{ "role": "drop", "address": "0x..." }],
  "transactions": [{
    "phaseId": "public",
    "quantity": 1,
    "from": "0x...",
    "to": "0x...",
    "recipient": "0x...",
    "data": "0x...",
    "value": "0"
  }]
}
```

3. With `DATABASE_URL`, `CERTIFICATION_RPC_URL`, the deployed commit SHA, and `CERTIFICATION_ATTESTATION_KEY` set, run:

```bash
npm run support:certify-definition -- <definition-version-id> <transaction.json>
```

4. Submit the emitted body to:

```text
POST /api/collections/:collectionId/definitions/:versionId/certify
```

5. Activate the passed definition separately:

```text
POST /api/collections/:collectionId/definitions/:versionId/activate
```

First activation atomically materializes the certified definition and records the certificate and actor in an activation ledger. A replacement additionally requires a clean ready shadow audit; activation retires the previous version and completes that cutover in the same transaction. Broadcasting always remains paused.

6. Inspect the activated definition, then explicitly release it with a reason:

```json
PATCH /api/collections/:collectionId/controls
{"projectPaused":false,"reason":"certificate and activation reviewed"}
```

Definitions and redacted certificate metadata are available from `GET /api/collections/:collectionId/definitions`.

## Revocation

`PATCH /api/collections/:collectionId/certifications/:certificationId` with a reason revokes a passed certificate. If no other valid passed certificate remains, the definition and project are paused immediately. Revoked certificates cannot be restored; a fresh fork/replay run is required.

## Deployment

`npm run db:ensure-phase02` and `npm run db:ensure-security` apply the idempotent certification and release-gate migrations under PostgreSQL advisory locks. Railway runs them before project staging. Production environment validation requires a distinct 32+ character `CERTIFICATION_ATTESTATION_KEY`.

`config/supported-projects.json` is intake only. Deployment staging may create an immutable draft, but it cannot mutate an existing live collection, issue a certificate, activate a version, or release broadcasting.

Legacy `seed-certifier-v1` records remain readable as historical evidence but have no runtime authority. The hardening migration automatically pauses any seed-only released collection. Scheduling, execution, cutover, and broadcast release require a fresh, expiring `mint-certifier-v1` certificate for the deployed commit.

After seeding, Railway runs `npm run db:verify-mint-foundation`. Deployment fails if required tables/triggers are absent, a non-terminal job is unpinned, an enabled collection lacks an active definition, or an active definition lacks a trusted valid certificate.
