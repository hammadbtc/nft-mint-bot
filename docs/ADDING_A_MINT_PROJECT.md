# Adding a supported mint project

This is the durable operator playbook for future MintBot sessions. A user should only paste a URL and choose wallets; all protocol research, transaction construction, and safety review happen before the project becomes searchable.

## Start every project-support session here

1. Read this file and `docs/PRODUCT_AND_AUDIT_HANDOFF.md`.
2. Run `git status --short`, `git log -3 --oneline`, `npm test`, and `npm run lint` before changing support.
3. Inspect `src/lib/adapters/index.ts` and existing adapters before building another one.
4. Collect the official mint URL, chain, phase, opening time with timezone, contract, desired quantity, and the wallet addresses that must be eligible. Never request private keys.
5. Keep the project unsupported until the exact transaction has been reproduced and simulated.

MintBot production may already have live broadcasting enabled. Adding a project is therefore a transaction-safety change, not a content edit. Registration must never automatically enqueue a job.

## Non-negotiable rule

Never infer a live transaction from a page label, guessed ABI, copied community link, or another collection on the same launchpad. Confirm the official domain, deployed protocol/version, target contract, calldata, value, phase state, and eligibility flow.

If any required input remains unknown, return `This mint is not supported yet`.

## Choose the correct support path

### 1. Existing adapter, new project record

Use an existing adapter only when the project uses the same reviewed protocol version and transaction shape. Recheck all addresses and live configuration per collection.

Current adapters:

- `opensea-seadrop-v1`: public SeaDrop only. It rereads price, start/end, wallet cap, fee-recipient permission, wallet mint stats, and supply on-chain at execution.
- `opensea-signed-seadrop-v1`: reviewed OpenSea SeaDrop schedules containing signed presales plus public. It authenticates each vault signer, reads per-stage eligibility without constructing or simulating a mint, and fetches the signed transaction only when preparing execution. Reusable wallet sessions are encrypted at rest and survive deploys. Prefer a permanent server-only `OPENSEA_API_KEY`; an official instant key is only a launch fallback.
- `evm-contract-v1`: only a verified payable function with either no arguments or one integer quantity argument and a static reviewed price.
- `squiggle-wuiggle-v1`: project-specific Robinhood adapter for the verified preminted-inventory contract. It supports deterministic arming but must not be reused for another collection merely because its ABI looks similar.

SeaDrop Merkle allowlists, token-gated phases, and other launchpads are not covered merely because OpenSea displays the collection. The signed adapter is limited to explicitly reviewed stages and the official OpenSea Drops API.

### 2. Reusable launchpad adapter

Build this when several projects share a stable, identifiable launchpad contract/API version. Pin the adapter to the actual version or deployment. Do not create a vague adapter that treats every contract on a domain as equivalent.

Examples of differences that require version-aware handling:

- Factory clone versus proxy versus shared mint router.
- Native payment versus ERC-20 approval.
- Direct contract phase data versus launchpad API data.
- Merkle proof versus server-issued signature.
- Payer, recipient, referrer, fee recipient, affiliate, or delegated minter fields.
- Fixed price versus Dutch auction or dynamic quote.

### 3. Custom project/personal-site adapter

Use a project-specific adapter when the official site calls a bespoke contract or API. The site UI is evidence, not the protocol definition. Inspect verified source and the transaction/API flow, then encode only the reviewed behavior.

Do not automate CAPTCHA bypasses, login bypasses, stolen session tokens, or anti-bot evasion. If a mint requires interactive human authorization that cannot be obtained through an official documented flow, leave it unsupported.

## Information to collect

- Official mint URL and canonical redirected URL.
- Official X/Discord/site announcement independently confirming the URL.
- Chain ID, native symbol, explorer, and at least two usable RPC endpoints.
- Launchpad name, protocol version, factory/router/drop addresses, and collection address.
- Target phase: public FCFS, allowlist, token-gated, holder, auction, or another type.
- Opening and ending time, original timezone, and whether the contract or an API is authoritative.
- Price source, currency, quantity rules, per-wallet cap, total supply, and existing wallet mints.
- Exact function, argument order/types, transaction `to`, `value`, and expected events.
- Proof, signature, nonce, deadline, salt, coupon, authorization, referrer, or fee-recipient rules.
- Whether payloads are wallet-bound, quantity-bound, phase-bound, expiring, or single-use.
- Desired main/worker wallet addresses for eligibility testing. Both active main and active worker wallets can mint.

## Investigation workflow

### A. Establish identity and chain

1. Confirm the domain through an official channel and record redirects.
2. Reject lookalike subdomains and paths. MintBot URL matchers are exact.
3. Confirm the browser wallet is on the expected chain.
4. Verify bytecode exists at every target/router/drop address.
5. Resolve proxies/clones to their implementation and verify the implementation source where possible.
6. Confirm the connected collection address matches the official collection, not merely a similarly named page.

### B. Reproduce the protocol

Prefer primary evidence: verified contract source, official launchpad documentation/SDK, and the official site’s own network/transaction requests.

Record a known-good unsigned transaction or wallet simulation:

- `from`
- `to`
- `chainId`
- `value`
- function selector and decoded arguments
- gas-estimation result
- any API request/response that produced a proof or signature
- expected revert before opening/ineligibility and expected success for an eligible address

Never broadcast while investigating. Never copy a transaction from another collection without decoding and comparing every field.

### C. Classify phase behavior

#### Public FCFS

- Resolve the authoritative opening time server-side.
- Queueing before open is allowed; the scheduler must not broadcast before the live phase.
- Reread price, pause state, wallet cap, and remaining supply immediately before signing.
- A successful simulation is not a guaranteed hit; sell-out and block competition remain external races.

#### Merkle allowlist

- Identify leaf encoding exactly, including address, allowance, price, phase ID, and any salt.
- Verify sorted-pair/tree rules and proof source.
- Recompute the leaf locally and, where possible, verify it against the on-chain root.
- Fetch/build the proof for the selected signing wallet at execution time.
- Test eligible and ineligible wallets. Never silently fall through to public mint.

#### Server-signed mint

- Identify the official payload endpoint and authorization method.
- Decode the EIP-712/domain or personal-sign message and confirm chain, verifying contract, signer, wallet, quantity, price, deadline, and nonce.
- Validate the recovered signer against an on-chain or otherwise authoritative signer address.
- Obtain short-lived signatures inside `buildTransaction`, not when the project is registered or scheduled.
- Store API credentials only in environment variables; never in `adapterConfig`, Git, logs, or client responses.

#### Token/holder-gated mint

- Identify the gating asset and snapshot/current-balance rule.
- Check eligibility for each signing wallet immediately before building the transaction.
- Confirm whether the token is consumed, locked, delegated, or merely checked.

#### Dutch auction/dynamic quote

- Calculate/read the execution-time price from the authoritative contract or official signed quote.
- Include a reviewed maximum/slippage rule where applicable.
- Never use the display price captured during registration as transaction value.

#### ERC-20 payment

- Confirm token address, decimals, required amount, spender, and approval type.
- MintBot can persist/recover an approval before minting, but the adapter must set `paymentToken` and build the correct mint transaction.
- Test insufficient token, insufficient gas, existing allowance, approval recovery, and revoked allowance.

## Adapter contract and lifecycle

Adapters live in `src/lib/adapters/` and implement `MintAdapter` from `types.ts`:

```ts
export interface MintAdapter {
  key: string;
  supportsArming?: boolean;
  requiresSignerForEligibility?: boolean;
  canArmPhase?(phaseId: string): boolean;
  resolve(collection, source): Promise<ResolvedMint>;
  checkEligibility?(collection, signerAddress, quantity, provider, phases, context?: { signer?: Signer }): Promise<MintPhaseEligibility[]>;
  buildTransaction?(collection, signerAddress, quantity, provider, options?: { allowBeforeStart?: boolean; phaseId?: string }): Promise<TransactionRequest>;
  recommendedGasLimit?: bigint;
}
```

`resolve` must:

- Validate reviewed configuration.
- Read authoritative phase data rather than trusting stale seed values.
- Return clear `upcoming`, `live`, or `ended` phases with ISO UTC timestamps.
- Return price in integer base units, wallet cap, and supply when available.
- Avoid wallet secrets and avoid returning API credentials/proofs to the browser.

`buildTransaction` runs immediately before simulation/signing and must:

- Revalidate phase, pause state, price, limits, supply, and signer eligibility.
- Fetch wallet-bound proof/signature/quote data just in time.
- Construct the exact reviewed `to`, `data`, `value`, and `chainId`.
- Fail closed on API/schema/version/signature changes.
- Never send, sign, allocate a nonce, or mutate external state itself. The engine owns simulation, durable signing, broadcasting, retries, receipts, and nonce locks.

For multi-stage projects, `resolve` returns all reviewed phases in precedence order, including ended/current/upcoming stages. `checkEligibility` returns an explicit `eligible`, `ineligible`, `unknown`, or `unsupported` result per phase for the signing wallet. The engine chooses the first eligible live phase, otherwise the earliest eligible upcoming phase, persists its `phaseId`, passes that ID into `buildTransaction`, and rechecks eligibility before execution. A gated phase without a reviewed checker is `unsupported`, never optimistically eligible.

### Eligibility scan contract

Eligibility answers only: **may this wallet participate in this phase for this quantity?** Keep it separate from mint readiness and transaction execution.

- Do not build, simulate, estimate gas, allocate a nonce, check native/ERC-20 funding, or require remaining global supply merely to display eligibility.
- Public eligibility is derived from the reviewed wallet rule (for example, remaining per-wallet allowance). `upcoming`, `ended`, paused, or sold out may affect phase readiness/status, but must not rewrite an otherwise eligible wallet as ineligible.
- Gated eligibility comes from that protocol's authoritative source: on-chain allowlist/root and proof, official wallet-scoped API, recovered server signature, token ownership rule, or other reviewed mechanism. OpenSea authentication is specific to OpenSea and must not be reused as a generic launchpad check.
- API failure, rate limiting, schema drift, authentication failure, or timeout produces `unknown` with a redacted reason. Only an authoritative negative result produces `ineligible`.
- Scan wallets with bounded concurrency, prioritize main wallets, respect `Retry-After`, show progressive results, and cache only credentials/results whose lifetime and revocation behavior are understood.
- Persist reusable credentials only encrypted at rest. Never log or expose wallet signatures, calldata, proofs, access tokens, API keys, or private keys.
- `buildTransaction` and final pre-sign revalidation separately enforce live timing, pause state, supply, funds, gas, allowance, exact price/value, recipient, calldata, proof/signature freshness, nonce, and spend policy.

Every eligibility adapter needs tests proving: eligible, authoritative ineligible, upstream failure becomes unknown, upcoming public remains wallet-eligible, sold-out does not become wallet-ineligible, insufficient funds does not change eligibility, and execution still rejects unsafe or unready transactions.

### Qualifying an adapter for armed FCFS execution

Set `supportsArming: true` only when the adapter can safely construct the exact future transaction before the phase is open. When `options.allowBeforeStart` is true, the adapter may bypass only the expected start-time rejection; it must still reread and validate router/drop addresses, fee recipients, pause/end state, price, cap, supply, and wallet eligibility.

An arming-capable adapter also needs a conservative `recommendedGasLimit` because pre-open `eth_estimateGas` commonly reverts. The engine uses it only when exact estimation fails, applies its fee ceiling, and records the signed transaction before launch. Final revalidation rebuilds and compares `chainId`, `to`, `data`, and `value`, then checks the signer, nonce, funds, and spend policy. A change fails closed rather than silently signing a different mint.

Do not enable arming for generic timestamp-only configuration, short-lived server signatures obtained too early, unknown dynamic pricing, or a protocol whose payload cannot be deterministically rebuilt. Such adapters remain on the normal safe execution path until a protocol-specific arming design exists.

Register a new adapter explicitly in `src/lib/adapters/index.ts`. A database `adapterKey` that is not in this registry must remain unusable.

## Adding another chain

If the chain is absent, add it to `src/lib/chains/index.ts` with its exact chain ID, symbol, explorer, dedicated-provider option, and independent public fallback. Providers must retain request timeouts and failover.

Before live support:

1. Verify `eth_chainId` on every RPC.
2. Verify latest block agreement and archive/state requirements used by the adapter.
3. Confirm fee model and receipt behavior.
4. Add production environment variables without committing keys.
5. Confirm `/api/status` reports at least two healthy endpoints for the live chain.

## Project registration

Register through `POST /api/collections`, protected by Basic Auth and `X-Support-Admin-Token`, or add a non-secret public record to `config/supported-projects.json` for idempotent deployment seeding.

Example for the deliberately limited generic adapter:

```json
{
  "name": "Example Collection",
  "slug": "example-collection",
  "contractAddress": "0x0000000000000000000000000000000000000001",
  "chainId": 1,
  "mintMethod": "mint",
  "mintAbi": ["function mint(uint256 quantity) payable"],
  "mintPrice": "10000000000000000",
  "maxPerWallet": 2,
  "maxSupply": 10000,
  "adapterKey": "evm-contract-v1",
  "domains": ["mint.example.com"],
  "siteUrl": "https://mint.example.com/mint",
  "adapterConfig": {
    "urlMatchers": [{ "domain": "mint.example.com", "path": "/mint" }],
    "phases": [{
      "id": "public",
      "name": "Public",
      "startsAt": "2026-08-20T18:00:00.000Z",
      "endsAt": "2026-08-21T18:00:00.000Z",
      "priceWei": "10000000000000000",
      "maxPerWallet": 2
    }]
  },
  "verified": true
}
```

Amounts are integer base-unit strings. `urlMatchers.path` is exact; do not use broad domain-only matching for multi-project launchpads. Do not place API keys, cookies, bearer tokens, proofs, signatures, wallet keys, or private endpoints in seed/config files.

```bash
curl --fail-with-body \
  --user "$APP_ACCESS_USER:$APP_ACCESS_PASSWORD" \
  -H "Content-Type: application/json" \
  -H "X-Support-Admin-Token: $SUPPORT_ADMIN_TOKEN" \
  --data @project.json \
  "https://YOUR-RAILWAY-DOMAIN/api/collections"
```

## Required tests

Every new adapter needs deterministic tests for:

- Exact calldata/value against a reviewed fixture or decoded official transaction.
- Phase selection before, during, and after the window.
- Eligible and ineligible signer behavior.
- Quantity, wallet cap, remaining supply, pause, and price changes.
- Bad/missing configuration and unexpected API response.
- Proof/signature verification and expiry when applicable.
- Exact official URL acceptance plus lookalike domain/path rejection.
- Sender-aware `eth_call` and gas estimation on a fork/testnet or a read-only mainnet block.

Then run:

```bash
npm test
npm run lint
npm run build
npx drizzle-kit check
npm audit
git diff --check
```

## Safe rollout

1. Register/seed the project without enqueueing anything.
2. Paste every official input form—URL, contract, exact name—and inspect displayed chain, contract, phase, time, price, cap, and supply.
3. Confirm lookalike inputs remain unsupported.
4. Run eligible and ineligible dry-runs where the phase/protocol permits simulation.
5. Test the actual intended main or worker wallet. The selected wallet is the simulation sender.
6. For a new adapter/protocol, execute a testnet/fork transaction or a deliberately tiny reviewed mainnet test before scaling wallet count/quantity.
7. Confirm idempotency, receipt reporting, restart recovery, and no duplicate broadcast.
8. Deploy, verify exact Git SHA, `/api/health`, authenticated `/api/status`, scheduler state, RPC health, and empty/unexpected queues.

## Updating and emergency disabling

Use the same project UUID with `POST /api/collections` to update a record. Seeded projects must be changed in Git so the next deploy does not restore an old value.

Immediately disable support if the official domain, implementation, router/drop address, API schema, authorized signer, phase configuration, or transaction shape changes unexpectedly:

```sql
UPDATE collections
SET active = false, verified = false
WHERE id = 'PROJECT_UUID';
```

For a durable seeded disable, also add the project to `config/disabled-projects.json`. Re-run the full investigation before restoring it.

## Future-session handoff template

Record these facts in the daily memory and commit message:

- Project name, official URLs, chain ID, collection and router/drop addresses.
- Protocol/launchpad and exact version or custom adapter key.
- Phase type, authoritative timing, price/currency, wallet cap, and supply.
- Proof/signature/eligibility source and validation method.
- Reviewed transaction selector, target, argument shape, and value rule.
- Tests/simulations performed, addresses used only in abbreviated form, and block/testnet reference.
- Commit SHA, deployment ID/status, health/status result, and whether any transaction was broadcast.
- Remaining limitations. Never claim public support covers allowlist/signed/token-gated phases unless that exact path was implemented and tested.
