# MintBot product and audit handoff

Last updated: 2026-08-12

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
- Funding and sweeping are explicit reviewed operations. No transaction is broadcast from a preview request.

## Mint adapter model

Every supported project has a reviewed adapter/configuration defining accepted domains, chain, contract, exact ABI/function and argument construction, phase data, pricing, limits, eligibility/proof handling and metadata. Platform adapters may be reused when a launchpad has a stable official protocol. Unsupported URLs return `unsupported`; they are never guessed into a live mint.

The full operator procedure and current generic-adapter limitations are documented in `docs/ADDING_A_MINT_PROJECT.md`.

Implemented platform support now includes `opensea-seadrop-v1` for reviewed public SeaDrop phases. It reads the live public-drop price, start/end, per-wallet limit, wallet mint stats and collection supply before constructing `mintPublic(address,address,address,uint256)`. Signed, allowlist and token-gated phases remain unsupported.

## Reliability rules

- Validate wallet/project/chain compatibility and quantities before creating jobs.
- Simulate and estimate the exact transaction with the signing wallet as `from` for live/immediate execution. For a contract-timed FCFS launch that reverts before opening, use only an adapter explicitly reviewed for arming: verify authoritative state, build and durably sign early, then compare the exact transaction intent and wallet nonce during final pre-launch revalidation.
- Use an idempotency key to prevent duplicate task creation.
- Claim scheduled jobs atomically and recover stale claims after process restarts.
- Persist the exact signed raw transaction and precomputed hash before broadcast; reconcile or rebroadcast those exact bytes after ambiguity/restart.
- Reserve nonces under a PostgreSQL advisory lock shared by Mint and Disperse.
- Report confirmed success only from a successful receipt.
- External races, sell-outs, project pauses and provider outages mean a 100% hit rate cannot be guaranteed.

## Armed FCFS launch engine

- The scheduler discovers launch work every 250 ms, but polling is not on the launch hot path.
- Reviewed arming-capable adapters prepare and durably store the exact signed payload 60 seconds before the contract start by default.
- Five seconds before opening, MintBot rereads authoritative phase/configuration/eligibility state, compares the intended `chainId`, `to`, `data`, and `value`, verifies the signer and exact pending nonce, rechecks balance/spend limits, and warms every write route.
- An in-process precise timer submits at the contract timestamp. The network requests are fired before any launch-time database write.
- Robinhood sends the identical signed bytes concurrently to the official sequencer, Alchemy/custom RPCs, and the public fallback. Redundant routes cannot create duplicate mints because the nonce, raw payload, and transaction hash are identical.
- Receipt reconciliation runs outside the submission path. Restarts restore armed timers from PostgreSQL; ambiguous submissions only rebroadcast the same persisted bytes.
- Timer drift and per-route acknowledgement latency are persisted without endpoint URLs or API credentials and shown in mint analytics.
- `MINT_ARM_LEAD_MS` and `MINT_REVALIDATE_LEAD_MS` are bounded environment overrides; defaults are 60,000 and 5,000 ms.

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
- Batch requests validate active verified support, server-resolved phase timing, quantity, wallet role/hierarchy and network, then create the whole batch atomically under an idempotency lock.
- Jobs may be scheduled while broadcasting is locked. The scheduler holds live work until both safety gates are enabled, while dry-runs can execute.
- Scheduled jobs and Disperse operations use expiring leases and restart recovery. Confirmed ERC-20 approvals resume the mint rather than counting as a completed mint.
- Disperse supports only fund-workers and sweep-to-main, requires a fresh fingerprinted fee/balance preview, queues atomically, and persists signed transfers before broadcast.
- Production access fails closed unless Basic Auth or an IP allowlist is configured. Cross-site mutations are rejected, security headers are set, secret comparisons are constant-time and adapter registration requires a separate admin token.
- Old V1 UI and unused FCFS/scanner/safety/analytics/config APIs were removed.
- `npm audit` reports zero known vulnerabilities after pinning the patched esbuild dependency used by tooling.
- Robinhood Chain mainnet is configured as chain ID 4663 with Alchemy/custom provider support, official public fallback, request timeouts and RPC failover. Live validation requires a second configured provider.
- Railway predeploy runs an idempotent reviewed-project seed and explicitly disables entries in `config/disabled-projects.json`.

## Current reviewed project state

- Active seed: Cash Rabbits, `0x5b05C950993705416C9069d43Ee70b564a875e40`, OpenSea slug `cash-rabbits`, Robinhood Chain.
- Active upcoming public-phase seed: CHIMPS HOOD, `0x3a1ACd38650397e93765BCD2D2E9714B074A482e`, OpenSea slug `chimps-hood`, Robinhood Chain. Reviewed public stage: free, maximum 5 per wallet, 5,000 max supply, 2026-08-13 14:00 UTC through 2026-08-14 14:00 UTC.
- Active upcoming public-phase seed: WEASELS IN STOCK, `0x808ef461a7982e0517ca647070BE251f6f115fCC`, OpenSea slug `weaselsinstock`, Robinhood Chain. Reviewed FCFS public stage: 0.00008 ETH, maximum 30 per wallet, 6,666 max supply, 2026-08-13 10:05 UTC through 2026-09-12 10:05 UTC.
- CHIMPS HOOD's earlier `Whitelist FCFS` and WEASELS IN STOCK's earlier `TEAM` stage are signed presales and remain unsupported by `opensea-seadrop-v1`. The records intentionally schedule only their on-chain public stages.
- Historical public configuration observed 2026-08-12: 0.0001 ETH, maximum 10 per wallet, 10,000 max supply, start 20:30:52 UTC on August 12, end 20:30:52 UTC on August 15. The adapter must use fresh chain state, not these recorded values.
- Removed seed: Hoodiez Brokers. Deployment explicitly marks it inactive and unverified at Hammad's request because he believed it was probably a scam.
- OpenSea showed Cash Rabbits `safelist_status: not_requested`; Blockscout showed the contract verified and not flagged. These signals do not establish project legitimacy.

## Verification completed

- Full ESLint pass with zero errors or warnings.
- TypeScript and optimized Next.js production build pass.
- Drizzle schema check passes.
- Twenty-eight unit tests pass, additionally covering precise non-early launch timing, direct-sequencer route order/uniqueness, exact raw-byte submission/hash verification, canonical signed-payload hashing, and supported-project search.
- Cash Rabbits was rechecked read-only after opening at Robinhood block 34,830,568: restricted fee recipient allowed, supply 3,499/10,000, exact one-mint `eth_call` passed and gas estimated at 112,573. Nothing was signed or broadcast.
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
