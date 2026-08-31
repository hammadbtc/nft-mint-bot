# Phase 5–6: Resolvers, parity cutover, and operations

Phase 5 adds evidence-producing launchpad resolvers. They inspect a hash-pinned block and deployed bytecode, record a content-addressed resolver run, and may prefill a draft. Resolver output never registers, certifies, activates, or unpauses a mint.

## Resolver support matrix

- OpenSea SeaDrop V1: qualified on-chain public-phase prefill. The resolver also detects Merkle, server-signed, and token-gated configuration; any such signal blocks generation until the complete phase schema and artifact source are supplied.
- OpenSea SeaDrop V2 ERC-1155 and Scatter: provider-payload capture only. A current provider response and complete phase metadata must be reviewed and certified; the backend does not infer an unpublished ABI.
- LaunchMyNFT: official-embed bytecode fingerprinting and prefill assistance. Full stage, fee, threshold, limit, and Merkle metadata are required.
- Transient and Blever/Runite: manual versioned plugin fixtures. No generic interface is guessed.

Provider-backed resolvers accept a normalized capture envelope shaped as `{ transaction: { chainId, to, data, value, from? }, phases }`. They record only content/intent hashes and non-secret selector/target/value observations. The raw provider response is not persisted by the resolver-run table.

Use `GET /api/resolvers` for descriptors and `POST /api/resolvers` to inspect. Both require `x-support-admin-token`. A `resolved` result can be submitted to the normal draft endpoint, followed by certification and activation. `needs-input` and `unsupported` results are hard stops.

## Shadow-mode cutover

Start an audit with `POST /api/collections/{id}/cutover` and action `start-shadow`. The candidate must already be a certified immutable definition. While legacy execution remains authoritative, the engine asynchronously builds the candidate transaction and compares the exact chain ID, target, calldata, and native value. It stores hashes and a minimal selector/target/value diff, never raw signed transactions or gated calldata.

`evaluate` can mark the audit ready only when the required match count is reached with zero mismatches and zero errors. Any mismatch or error requires rollback and a new audit cycle. Replacement activation takes the same database locks as cutover evaluation, recomputes the clean sample counts, activates the certified definition, and records `cutover` in one transaction. `mark-cutover` is now an idempotent compatibility action only; it cannot advance state independently. Broadcasting remains paused until a separately authenticated release verifies the active certificate and completed replacement cutover. Legacy adapters are retained for rollback; no automatic deletion occurs.

`mark-rollback` immediately pauses broadcasting and moves the audit to `rollback`, including after a completed cutover. To restore a previous definition, produce a fresh certificate for the current commit, start a reverse shadow audit from the current active definition to that candidate, collect clean parity, and activate it through the same atomic gate. A rollback never silently swaps transaction code.

## Readiness and incident replay

`POST /api/collections/{id}/readiness` accepts wallet IDs and quantity. It reports, per wallet, definition certification, project/phase controls, chain-verified RPC health, role/chain policy, phase eligibility and artifact expiry, exact mint value plus gas funding, and prepared-task state. A wallet is not ready merely because it has an active task: armed work must have a nonce, encrypted signed payload, transaction hash, and a still-valid pending nonce. It returns address hashes rather than addresses and never returns proof/signature payloads.

Permanent execution failures, exhausted retries, and armed final-revalidation failures automatically create content-addressed incident replay bundles. Bundles contain job timing, transaction hashes and intent hashes, route/stage telemetry, controls and shadow evidence. Raw signed transactions, encrypted fields, definition snapshots, provider credentials, private keys, and artifact payloads are redacted. Support can explicitly capture the current state with `POST /api/jobs/{id}/incident-bundle`.

## Chain and chaos operations

`EXTRA_CHAINS_JSON` adds complete EVM chain definitions or additional HTTPS routes for a built-in chain without a code release. RPC quota errors quarantine a route, fallback providers keep quorum at one healthy route, and readiness exposes route state without endpoint URLs. `npm run rpc:check` validates chain IDs and block reads.

The regression suite covers exact intent parity/mismatch, no-go cutover counts, replay determinism/redaction, resolver support claims, RPC quarantine, duplicate-worker idempotency, prepared-transaction restart recovery, database restart leases, and launch timing budgets.

## Deployment order

1. Deploy code while broadcasting remains paused.
2. Run `npm run db:ensure-phase05` and `npm run db:ensure-phase06` (start, worker, and Railway predeploy run these automatically).
3. Run `npm run db:verify-mint-foundation`.
4. Resolve and register candidates, then complete pinned-block certification.
5. Start shadow audits and collect exact matches across every phase and representative wallet/quantity shape.
6. Resolve all mismatch/error cycles, evaluate readiness, and activate the candidate; activation completes the clean cutover atomically.
7. Inspect the wallet readiness dashboard, then explicitly release broadcasting. Keep the previous certified definition and legacy adapter available for rollback.
