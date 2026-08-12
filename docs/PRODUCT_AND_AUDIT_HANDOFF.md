# MintBot product and audit handoff

Last updated: 2026-08-12

## Product promise

MintBot is a focused, single-user minting tool. The visible workflow is:

1. Paste a supported mint URL.
2. Load verified project, phase, price, supply, timing and eligibility data.
3. Select worker wallets and quantity.
4. Mint immediately or schedule for launch.
5. Review per-wallet hits, misses, transaction hashes, gas and exact errors.

The only main pages are Mints, Wallets and Disperse. Light and dark themes are supported.

## Explicit scope

- Mints: URL resolver, supported-project adapters, scheduling and results.
- Wallets: one main wallet with independently generated/imported worker wallets.
- Disperse: fund workers from main and sweep funds back to main.
- Technical details such as RPC selection, gas, nonces, simulation and retries remain automatic.

## Explicit non-goals for the first release

- User accounts, MetaMask login, subscriptions or multi-tenancy.
- Analytics, RPC, collection, job, safety or settings dashboards.
- Arbitrary ABI guessing presented as safe mint support.
- Unverified project URLs or a promise of a 100% hit rate.
- Social automation, raffles, marketplace trading or unrelated tools.

## Wallet model

- A main wallet is the funding and consolidation wallet.
- Worker wallets are independent keys grouped under a main wallet; they are not derived from the main seed.
- Generated secrets must be shown exactly once for backup and encrypted before database storage.
- Funding and sweeping are explicit reviewed operations. No transaction is broadcast from a preview request.

## Mint adapter model

Every supported project has a reviewed adapter/configuration defining accepted domains, chain, contract, exact ABI/function and argument construction, phase data, pricing, limits, eligibility/proof handling and metadata. Platform adapters may be reused when a launchpad has a stable official protocol. Unsupported URLs return `unsupported`; they are never guessed into a live mint.

The full operator procedure and current generic-adapter limitations are documented in `docs/ADDING_A_MINT_PROJECT.md`.

## Reliability rules

- Validate wallet/project/chain compatibility and quantities before creating jobs.
- Simulate the exact transaction before broadcast.
- Use an idempotency key to prevent duplicate task creation.
- Claim scheduled jobs atomically and recover stale claims after process restarts.
- Never retry an ambiguous broadcast as if it were a pre-broadcast failure.
- Persist transaction hashes as soon as broadcast succeeds.
- Report confirmed success only from a successful receipt.
- External races, sell-outs, project pauses and provider outages mean a 100% hit rate cannot be guaranteed.

## Current frontend state

- The old Dashboard, Collections, Jobs, Analytics, RPC, Safety, Settings and Batch Mint pages were removed.
- `/` is Mints, `/wallets` is Wallets and `/disperse` is Disperse.
- The new UI includes theme switching, mint search/results, wallet import/generation and Disperse review scaffolding.
- The production Next.js build passes.

## Implemented backend state

- Wallet secrets fail closed without a 32+ character vault passphrase.
- One main wallet per network; workers must be independent same-network children of that main.
- Generated worker keys are returned once with no-cache headers for immediate backup.
- Exact verified domain/contract/name resolution through a registered adapter; unsupported inputs are rejected.
- Batch requests validate support, quantity and network, enqueue quickly and use per-wallet idempotency keys.
- Scheduled jobs are atomically claimed. Transaction hashes are persisted before receipt waiting; ambiguous broadcasts are never retried automatically.
- Disperse supports only fund-workers and sweep-to-main, requires a fresh exact preview and is disabled for live broadcasting by default.
- Production access fails closed unless Basic Auth or an IP allowlist is configured. Adapter registration requires a separate admin token.
- Old V1 UI and unused FCFS/scanner/safety/analytics/config APIs were removed.
- Runtime high-severity dependency findings were patched. Remaining audit findings are moderate and confined to the development-only Drizzle CLI dependency chain.

## Verification completed

- Full ESLint pass with zero errors or warnings.
- TypeScript and optimized Next.js production build pass.
- Drizzle schema check passes.
- Unit tests cover randomized encrypted-secret round trips, missing-passphrase failure and reviewed adapter parsing/rejection.
- Live blockchain execution has intentionally not been enabled or claimed as tested; RPC selection, a real adapter and testnet funds are still required.

## Required external configuration before live funds

- PostgreSQL `DATABASE_URL`.
- A strong `VAULT_PASSPHRASE`; production must not use a fallback.
- At least two tested RPC endpoints for each enabled chain.
- Launchpad/project API credentials only where an adapter requires them.
- A testnet adapter/contract and funded test wallets for end-to-end testing.

## High-reasoning review checklist

Review schema migrations, secret lifecycle, authorization assumptions, URL/domain matching, adapter transaction construction, allowlist proof/signature handling, nonce allocation, job claiming, idempotency, retry classification, broadcast persistence, receipt interpretation, RPC failover, Disperse totals, gas reserve logic, sweep behavior, logging redaction, dependency audit and restart recovery. Run unit, integration, production build and testnet end-to-end tests before enabling mainnet.
