# Phase 3–4: Reviewed execution and wallet plans

Phase 3 replaces ad-hoc generic mint patching with the `reviewed-call-v1` adapter. A definition declares every phase, exact canonical function signature, target policy, typed ABI argument binding, native-value rule, wallet cap, opening rule, and eligibility strategy. The backend compiles calldata from server-owned inputs and refuses caller-supplied transaction bytes.

## Phase 3 invariants

- Function names are canonical signatures such as `mint(address,uint256)`, not ambiguous overload names.
- ABI input count and types exactly match reviewed bindings.
- Wallet bindings target only `address`; quantity bindings target only integer inputs.
- Public phases cannot consume wallet artifacts.
- Native value is zero, a reviewed constant, or reviewed unit price multiplied by quantity.
- Manual openings use a reviewed, wallet-independent boolean view call and are polled again before signing.
- Registration creates a draft only. Fork/replay certification and explicit activation remain mandatory.

The certification input for `reviewed-call-v1` uses a top-level `transactions` array with one `{ phaseId, quantity, from, recipient, to, data, value }` item per configured phase. The runner decodes each item, checks wallet/quantity/constants, simulates each transaction at the same pinned block, records bytecode for every reviewed target/gate/token contract, and refuses certification when any phase is omitted.

The legacy `evm-contract-v1` adapter remains available for existing definitions. New draft requests default to `reviewed-call-v1`.

## Phase 4 eligibility strategies

`reviewed-call-v1` supports public, Merkle proof, reviewed server signature, token balance, and reviewed on-chain boolean eligibility.

Merkle and signature artifacts are uploaded through `POST /api/collections/{collectionId}/definitions/{versionId}/eligibility-artifacts`. The request requires `x-support-admin-token` and contains one phase plus wallet-scoped artifacts. Each item includes a SHA-256 `sourceHash` for the originating allowlist/export. Payloads are strategy-validated before AES-256-GCM encryption.

At planning time the backend resolves every wallet independently. A gated plan is schedulable only when its artifact is valid and does not expire before launch. The artifact ID and content hash are copied into each mint job. PostgreSQL triggers make that pin immutable and verify the same collection, definition, phase, and non-expired artifact.

Replacing an artifact after jobs are scheduled makes old jobs fail closed because their pinned hash no longer matches. They must be cancelled and planned again.

## Deployment order

1. Deploy with the vault, certification, admin, and transaction-gate secrets configured.
2. Run `npm run db:ensure-phase01`, `npm run db:ensure-phase02`, and `npm run db:ensure-phase04`.
3. Register a `reviewed-call-v1` draft.
4. Certify it at a pinned chain/block and activate it.
5. Upload wallet artifacts for gated phases.
6. Inspect wallet eligibility, schedule exact phases, then explicitly release the project broadcast pause.

Railway predeploy, web start, and worker start run the Phase 4 migration automatically. `db:verify-mint-foundation` checks the new table and eligibility safety triggers.
