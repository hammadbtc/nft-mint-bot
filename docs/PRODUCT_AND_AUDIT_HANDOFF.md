# MintBot product and audit handoff

Last updated: 2026-08-23

## Product promise

MintBot is a focused, single-user minting tool. The visible workflow is:

1. Paste a supported mint URL.
2. Load verified project, phase, price, supply, timing and eligibility data.
3. Select active main and/or worker wallets and quantity.
4. Mint immediately or schedule for launch.
5. Review per-wallet hits, misses, transaction hashes, gas and exact errors.

The only main pages are Mints, Wallets and Disperse. Light and dark themes are supported.

## Explicit scope

- Mints: URL resolver, supported-project adapters, scheduling and results.
- Wallets: one main wallet per network with optional independently generated/imported worker wallets. Main and worker wallets may mint.
- Disperse: fund workers from main and sweep funds back to main.
- Technical details such as RPC selection, gas, nonces, simulation and retries remain automatic.

## Explicit non-goals for the first release

- User accounts, MetaMask login, subscriptions or multi-tenancy.
- Analytics, RPC, collection, job, safety or settings dashboards.
- Arbitrary ABI guessing presented as safe mint support.
- Unverified project URLs or a promise of a 100% hit rate.
- Social automation, raffles, marketplace trading or unrelated tools.

## Wallet model

- A main wallet is the funding/consolidation wallet and may also mint directly for a simple one-wallet setup.
- Worker wallets are independent keys grouped under a main wallet; they are not derived from the main seed.
- Mint selection accepts any active same-chain main wallet. An active worker is accepted only while its same-chain main parent remains active.
- Generated secrets must be shown exactly once for backup and encrypted before database storage.
- Wallet labels and active state can be edited. An address is never edited independently: replacing it requires the matching private key or seed, the server derives the address, fresh admin approval is required, and wallets with audit history must instead be imported as new wallets.
- Wallet removal requires fresh admin approval. Wallets with job or transfer history are deactivated rather than erased; main wallets cannot be removed while child workers exist.
- Funding and sweeping are explicit reviewed operations. No transaction is broadcast from a preview request.

## Mint adapter model

Every supported project has a reviewed adapter/configuration defining accepted domains, chain, contract, exact ABI/function and argument construction, phase data, pricing, limits, eligibility/proof handling and metadata. Platform adapters may be reused when a launchpad has a stable official protocol. Unsupported URLs return `unsupported`; they are never guessed into a live mint.

The full operator procedure and current generic-adapter limitations are documented in `docs/ADDING_A_MINT_PROJECT.md`.

Implemented platform support includes `opensea-seadrop-v1` for reviewed public SeaDrop phases. It reads the live public-drop price, start/end, per-wallet limit, wallet mint stats and collection supply before constructing `mintPublic(address,address,address,uint256)`. Signed, allowlist and token-gated phases remain unsupported. The core is multi-phase and wallet-aware: adapters may return every ordered reviewed phase plus per-wallet eligibility, the UI displays them all, and each wallet routes to its first eligible live phase or earliest eligible upcoming phase. Gated phases fail closed unless their adapter implements the exact proof/signature/ownership check. `squiggle-wuiggle-v1` is a bespoke armed adapter for the verified Squiggle Wuiggle inventory-sale contract; OpenSea displaying the collection does not make it a SeaDrop mint.

## Reliability rules

- Validate wallet/project/chain compatibility and quantities before creating jobs.
- Simulate and estimate the exact transaction with the signing wallet as `from` for live/immediate execution. For a contract-timed FCFS launch that reverts before opening, use only an adapter explicitly reviewed for arming: verify authoritative state, build and durably sign early, then compare the exact transaction intent and wallet nonce during final pre-launch revalidation.
- Use an idempotency key to prevent duplicate task creation.
- Claim scheduled jobs atomically and recover stale claims after process restarts.
- Persist the exact signed raw transaction and precomputed hash before broadcast; reconcile or rebroadcast those exact bytes after ambiguity/restart.
- Reserve nonces under a PostgreSQL advisory lock shared by Mint and Disperse.
- Report confirmed success only from a successful receipt.
- Pending unsigned mint tasks may change wallet or quantity; the server refreshes authoritative contract phase timing during the edit. Deletion requires fresh admin approval. Armed, running, submitted, or historical work remains immutable.
- A wallet may queue multiple projects. The scheduler orders eligible work by authoritative launch time and permits only the first task per wallet to arm/run at once; later tasks do not reserve a nonce until that wallet is free.
- External races, sell-outs, project pauses and provider outages mean a 100% hit rate cannot be guaranteed.
- Adapter capability is phase-specific. Payload warming and payload-based eligibility proof must never be inferred from method presence, an adapter-wide flag, or another phase using the same adapter.
- A project seed cannot reach production unless `npm run support:certify` proves its adapter registration, execution manifest, phase ordering, signed/public field separation, and per-phase arming/payload capability matrix. Railway runs this before seeding.
- Read-only RPC checks and unit tests are necessary but do not certify the authenticated vault-wallet job lifecycle. When that rehearsal is unavailable, readiness must be reported as blocked rather than assumed.

## Armed FCFS launch engine

- The scheduler discovers launch work every 250 ms, but polling is not on the launch hot path.
- Reviewed arming-capable adapters prepare and durably store the exact signed payload 60 seconds before the contract start by default.
- Five seconds before opening, MintBot rereads authoritative phase/configuration/eligibility state, compares the intended `chainId`, `to`, `data`, and `value`, verifies the signer and exact pending nonce, rechecks balance/spend limits, and warms every write route.
- An in-process precise timer submits at the contract timestamp. The network requests are fired before any launch-time database write.
- Robinhood sends the identical signed bytes concurrently to the official sequencer, Alchemy, named dRPC/QuickNode/Chainstack endpoints when configured, any custom RPCs, and the public fallback. Redundant routes cannot create duplicate mints because the nonce, raw payload, and transaction hash are identical. Telemetry identifies providers by hostname but never stores endpoint URLs or credentials.
- Receipt reconciliation runs outside the submission path. Restarts restore armed timers from PostgreSQL; ambiguous submissions only rebroadcast the same persisted bytes.
- Timer drift and per-route acknowledgement latency are persisted without endpoint URLs or API credentials and shown in mint analytics.
- `MINT_ARM_LEAD_MS` and `MINT_REVALIDATE_LEAD_MS` are bounded environment overrides; defaults are 300,000 and 5,000 ms, and arming has a five-minute safety floor. Competitive server-signed jobs must show `armed` before launch; zero armed jobs is a release blocker, not a cosmetic state.

## Current frontend state

- The old Dashboard, Collections, Jobs, Analytics, RPC, Safety, Settings and Batch Mint pages were removed.
- `/` is Mints, `/wallets` is Wallets and `/disperse` is Disperse.
- The new UI includes theme switching, mint search/results, wallet import/generation and Disperse review scaffolding.
- The production Next.js build passes.
- Mint prices are formatted from wei to ETH, current/max supply is read on-chain, and users no longer enter a manual schedule. Upcoming phases automatically show/use the contract opening time; live phases queue for immediate execution. The action is labeled `Schedule mint` in both cases.

## Implemented backend state

- Wallet secrets fail closed without a 32+ character vault passphrase.
- One main wallet per network; workers must be independent same-network children of that main.
- Generated worker keys are returned once with no-cache headers for immediate backup.
- Exact verified domain/contract/name resolution through a registered adapter; unsupported inputs are rejected.
- Batch requests validate active verified support, server-resolved phase timing, quantity, wallet role/hierarchy and network, then create the whole batch atomically under an idempotency lock. Wallets in one batch may route to different reviewed phases based on their own verified eligibility.
- Destructive task/wallet actions use a constant-time checked `ADMIN_ACTION_PASSWORD`, falling back to the existing browser access password when a separate secret is not configured.
- Jobs may be scheduled while broadcasting is locked. The scheduler holds live work until both safety gates are enabled, while dry-runs can execute.
- Scheduled jobs and Disperse operations use expiring leases and restart recovery. Confirmed ERC-20 approvals resume the mint rather than counting as a completed mint.
- Disperse supports only fund-workers and sweep-to-main, requires a fresh fingerprinted fee/balance preview, queues atomically, and persists signed transfers before broadcast.
- Production access fails closed unless Basic Auth or an IP allowlist is configured. Cross-site mutations are rejected, security headers are set, secret comparisons are constant-time and adapter registration requires a separate admin token.
- Old V1 UI and unused FCFS/scanner/safety/analytics/config APIs were removed.
- `npm audit` reports zero known vulnerabilities after pinning the patched esbuild dependency used by tooling.
- Robinhood Chain mainnet is configured as chain ID 4663 with Alchemy/custom provider support, official public fallback, request timeouts and RPC failover. Live validation requires a second configured provider.
- Railway predeploy runs an idempotent reviewed-project seed and explicitly disables entries in `config/disabled-projects.json`.

## Current reviewed project state

- Incident record — Rekt Tradooor Phase 2, 2026-08-21: supply was 8,183/10,000 at 17:15:00 UTC and reached 10,000 at 17:15:29. Seven eligible jobs missed the window because `opensea-signed-seadrop-v1` prohibited signed-phase arming and repeated remote phase/eligibility work after opening. Exact simulation then correctly rejected supply 10,001 over maximum 10,000, but the critical-path architecture had already failed. The adapter now requires a validated pre-open payload and creates a genuinely armed raw signed transaction; final revalidation does not repeat OpenSea authentication/eligibility. Any competitive signed launch with jobs not visibly `armed` is no-go.
- Incident record — BigD public stage, 2026-08-23: the mixed `opensea-signed-seadrop-v1` adapter exposed a provider-payload warmer for the whole adapter while the public phase required deterministic on-chain `mintPublic`. The scheduler called the signed warmer for public and failed before transaction construction. The adapter now declares payload warming and payload-as-eligibility-proof per phase; public is explicitly false, signed is explicitly true. A cross-project certification test checks every mixed OpenSea seed, and Railway predeploy blocks contradictory phase capabilities.
- Active seed: Cash Rabbits, `0x5b05C950993705416C9069d43Ee70b564a875e40`, OpenSea slug `cash-rabbits`, Robinhood Chain.
- Active upcoming public-phase seed: CHIMPS HOOD, `0x3a1ACd38650397e93765BCD2D2E9714B074A482e`, OpenSea slug `chimps-hood`, Robinhood Chain. Reviewed public stage: free, maximum 5 per wallet, 5,000 max supply, 2026-08-13 14:00 UTC through 2026-08-14 14:00 UTC.
- Active upcoming public-phase seed: WEASELS IN STOCK, `0x808ef461a7982e0517ca647070BE251f6f115fCC`, OpenSea slug `weaselsinstock`, Robinhood Chain. Reviewed FCFS public stage: 0.00008 ETH, maximum 30 per wallet, 6,666 max supply, 2026-08-13 10:05 UTC through 2026-09-12 10:05 UTC.
- Active upcoming public-phase seed: Purr Cat, `0xCe905281c45014B37A4597f9964299F1e9B6dF06`, OpenSea slug `purr-cats-nft`, Robinhood Chain. Reviewed public stage: 0.0001 ETH, maximum 100 per wallet, 10,000 max supply, 2026-08-13 08:15:01 UTC through 2026-08-14 09:15:01 UTC. The collection is an EIP-1167 clone of the same `0x09a26f...1Dd6A` token implementation as the other reviewed Robinhood SeaDrop projects and uses SeaDrop `0x00005E...24bf5` with OpenSea's restricted fee recipient allowlisted.
- Active upcoming custom-contract seed: Squiggle Wuiggle, collection `0x65E0B476Ce5c9849E6c26fb06042479e552E309C`, minter `0x2897e59840e6e3Deb1dBf56dD7F32d20C26a69eB`, adapter `squiggle-wuiggle-v1`, Robinhood Chain. The verified minter transfers an already-preminted 7,500-token inventory via `mint(uint256)`, charges exactly 0.0016 ETH each, allows 1–2 per transaction with no on-chain wallet cap, and currently opens 2026-08-13 16:30 UTC. The adapter rereads the mutable start timestamp, fixed constants, collection linkage, inventory accounting/readiness, 10,000 fixed collection supply, and receiver-specific transfer-policy check before signing. The announcement's claim that the time cannot be changed is inaccurate: the verified owner can call `setSaleStartTime`, so execution must continue to trust fresh chain state.
- CHIMPS HOOD's earlier `Whitelist FCFS` and WEASELS IN STOCK's earlier `TEAM` stage are signed presales and remain unsupported by `opensea-seadrop-v1`. The records intentionally schedule only their on-chain public stages.
- Historical public configuration observed 2026-08-12: 0.0001 ETH, maximum 10 per wallet, 10,000 max supply, start 20:30:52 UTC on August 12, end 20:30:52 UTC on August 15. The adapter must use fresh chain state, not these recorded values.
- Removed seed: Hoodiez Brokers. Deployment explicitly marks it inactive and unverified at Hammad's request because he believed it was probably a scam.
- OpenSea showed Cash Rabbits `safelist_status: not_requested`; Blockscout showed the contract verified and not flagged. These signals do not establish project legitimacy.

## Verification completed

- Full ESLint pass with zero errors or warnings.
- `npm run support:certify` is a mandatory CI/predeploy gate for every supported seed and every phase of a mixed signed/public OpenSea adapter.
- TypeScript and optimized Next.js production build pass.
- Drizzle schema check passes.
- Thirty-six unit tests pass, additionally covering destructive-action password fallback, immutable attempted/non-pending mint tasks, per-wallet queued-task arbitration, signing-key-derived wallet replacement, precise non-early launch timing, direct-sequencer route order/uniqueness, provider identification, exact raw-byte submission/hash verification, canonical signed-payload hashing, supported-project search, exact Squiggle Wuiggle calldata/payment, pre-open rejection, quantity bounds, and reviewed URL/contract bindings.
- Cash Rabbits was rechecked read-only after opening at Robinhood block 34,830,568: restricted fee recipient allowed, supply 3,499/10,000, exact one-mint `eth_call` passed and gas estimated at 112,573. Nothing was signed or broadcast.
- Purr Cat was checked read-only before opening at Robinhood block 35,219,159: chain ID 4663, supply 2,499/10,000, public price 0.0001 ETH, cap 100, restricted fee recipient allowed, and exact one-mint calldata/value reproduced. The call reverted with SeaDrop's expected `NotActive` error because block time was 07:41:47 UTC and the phase starts at 08:15:01 UTC. Nothing was signed or broadcast.
- Mainnet broadcasting is enabled by Hammad's explicit instruction. No live mint or Disperse transaction has yet been broadcast, so a deliberately tiny real transaction remains the final end-to-end proof.

## Required external configuration before live funds

- PostgreSQL `DATABASE_URL`.
- A strong `VAULT_PASSPHRASE`; production must not use a fallback.
- At least two tested RPC endpoints for each enabled chain.
- Launchpad/project API credentials only where an adapter requires them.
- A testnet adapter/contract and funded test wallets for end-to-end testing.

## High-reasoning review checklist

Review schema migrations, secret lifecycle, authorization assumptions, URL/domain matching, adapter transaction construction, allowlist proof/signature handling, nonce allocation, job claiming, idempotency, retry classification, broadcast persistence, receipt interpretation, RPC failover, Disperse totals, gas reserve logic, sweep behavior, logging redaction, dependency audit and restart recovery. Run unit, integration, production build and testnet end-to-end tests before enabling mainnet.

Verify Railway deploy/predeploy logs, database migrations, disabled-project enforcement, project resolution, authenticated `/api/status`, live-gate state and server-derived scheduling. Never change live variables without Hammad's explicit instruction.
