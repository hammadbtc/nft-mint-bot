# MintBot Mega Plan V2 — Before/After Engineering Report

Release: `3f23d06`  
Production verified: 2026-08-18 03:50 UTC  
Prepared for: Hammad  

## Executive result

MintBot has moved from a safety-first web scheduler into a reusable launch engine. The old path performed discovery, repeated state reads, gas estimation, simulation, signing, database work, broadcast, and receipt waiting during the race. V2 moves deterministic work before launch, uses an event-driven signal plus bounded fallback, reserves nonce ladders atomically, sends exact signed bytes sequencer-first, reconciles receipts outside the submission path, and records every important latency and suppression reason.

This does not guarantee a mint. FCFS remains competitive, providers can fail, launchpads can throttle, contracts can change, and supply can disappear before inclusion. V2 removes known self-inflicted delays and makes every miss explainable.

## Incident baseline

Terminal Assistants opened at 16:03:45 UTC and sold out at 16:04:52 UTC: 67 seconds. The first successful transactions arrived almost immediately. The old Terminal path could wait 2.5 seconds before detecting the owner switch, repeat multi-block stability checks, estimate and simulate at launch, process same-wallet jobs serially, and wait for earlier receipts. That architecture was not competitive for Robinhood's first-come, first-served sequencer.

Disperse had a separate failure mode: operations were accepted into PostgreSQL but the old page exposed only “queued.” A 1.25× fee ceiling could reject work after preview, one failure could strand later transfers, and the execution lane competed with mint jobs.

## Before and after

| Area | Before V2 | V2 production release |
|---|---|---|
| Project onboarding | Project-specific adapter work and session knowledge | Validated engine manifest plus reviewed project configuration |
| Timed public mint | Work performed near/at opening | Gas, intent, nonce and signed bytes prepared durably before opening; precise timer submits at contract time |
| Signed tier | OpenSea auth and payload fetch on critical path | Wallet-bound payload validated, nonce reserved, and exact raw transaction signed/persisted before launch; no remote auth at launch |
| Stealth detection | 2.5-second retry and HTTP-only reads | Provider WebSocket block wakeups plus 250ms bounded HTTP fallback |
| State safety | Reads could span provider block heights | Final wallet/open/supply reads pinned to one block |
| Five one-per-tx mints | Five manual tasks, serial execution | One “5 sequential transactions” choice, atomic contiguous nonce ladder, concurrent submission |
| Gas | Estimate during launch | Reviewed gas limit for latency-sensitive engines; fee read only |
| Broadcast | Normal provider route | Robinhood sequencer first; identical signed bytes concurrently sent to independent fallbacks |
| Supply pressure | Later tasks fail after signing/broadcast | Authoritative capacity suppresses unsafe ladder entries before signing |
| Recovery | Partial observability | Durable raw bytes/hash, exact-hash rebroadcast, restart reconciliation |
| Disperse | “Queued” with hidden failure | Live operation/transfer state, exact error/hash/block, safe never-broadcast retry |
| Funding | Serial transfer and receipt waits | Atomic funding nonce ladder and no per-transfer receipt wait before the next submission |
| Sweep | Serial across workers | Concurrent across independent wallet nonce domains |
| Bulk contract | No review gate | Fail-closed audit/source/runtime-code-hash approval gate; no contract is active until independently approved |
| Execution process | Scheduler embedded in the web app | Explicit web/worker/combined roles and durable worker heartbeat; current Railway deployment uses compatibility `combined` mode |
| Monitoring | Coarse health | Worker, watcher, timer, lease, RPC and broadcast-route health plus per-stage p50/p95 telemetry |

## Reusable execution engines

1. `scheduled-public-v1`: static public calldata, pre-arm, precise timer, sequencer-first broadcast.
2. `scheduled-server-signed-v1`: authenticated eligibility during preparation, wallet-bound payload validation, static prearm, and exact-timer raw-byte broadcast. Failure to prearm is a launch-blocking condition; there is no competitive JIT fallback.
3. `stealth-owner-switch-v1`: WebSocket wakeup, on-chain switch probe, pinned snapshot, optional dedicated-worker nonce ladder.
4. `custom-reviewed-v1`: explicit adapter fallback for contracts that cannot safely fit a standard engine.

Every project manifest is validated against its adapter. A mismatched or missing engine fails before eligibility, preparation, or scheduling. Project-specific values remain data; nonce policy, retry classification, broadcast routing, telemetry, and recovery live in reusable tested engines.

## Launch path now

### Before opening

- Resolve and verify exact project/phase/contract intent.
- Authenticate signed-stage wallets, obtain and validate their payloads, reserve nonces, sign, and durably store raw transactions. A warmed payload without stored signed bytes is not armed.
- Estimate scheduled-public gas or apply a reviewed latency-engine gas limit.
- Validate balance and spend limit.
- Reserve wallet nonce(s) under a PostgreSQL advisory lock.
- Sign and durably store exact bytes and precomputed hashes.
- Warm broadcast DNS/TLS/provider connections.
- Revalidate target, calldata, value, signer, nonce, funds and schedule without repeating remote signed-stage authentication or eligibility.

### At opening

- Precise timer or provider WebSocket wakes the engine.
- Stealth engines perform one pinned-block safety snapshot.
- The direct Robinhood sequencer receives exact signed bytes first.
- Independent configured routes receive the same bytes concurrently.
- Multiple sequential nonces are submitted without waiting for receipts.
- No launch-time database discovery is required for armed public transactions.

### After submission

- Persist route acknowledgements and latency outside the network-send step.
- Reconcile by the precomputed hash.
- Confirm success only from a status-1 receipt.
- Suppress excess work when wallet room or supply is insufficient.
- Preserve exact errors and timestamps for incident replay.

## Disperse and sweep repair

- Mint and Disperse use independent scheduler lanes.
- The reviewed fee ceiling is 3× the preview quote; actual gas is still the effective gas used, not the ceiling.
- Funding transfers from one main wallet reserve a contiguous nonce ladder atomically and submit without serial receipt waits.
- Sweeps run concurrently because every worker has an independent nonce domain.
- A normal failed transfer no longer hides or abandons unrelated transfers.
- The UI shows pending, prepared, submitted, confirming, confirmed and failed states; exact errors; amounts; hashes; explorer links; blocks; and automatic polling.
- Retry is allowed only when status is failed and nonce, signed bytes and transaction hash are all absent. Prepared/submitted work is reconciled by exact hash and can never be recreated as a duplicate payment.
- Bulk-contract execution fails closed unless chain, contract address, independent audit URL, verified-source URL and exact runtime bytecode hash are approved. No Robinhood bulk contract is currently approved, so MintBot uses its reviewed nonce-ladder path.

## Observability and recovery

Each job records monotonic duration and wall-clock correlation for open detection, phase resolution, payload acquisition, gas preparation, simulation, final revalidation, signing, broadcast and receipt reconciliation. Route telemetry stores provider labels and latency but never endpoint URLs or API credentials.

Health now detects:

- dead or stale execution worker;
- disconnected/stale block watcher;
- armed jobs without matching launch timers;
- stale mint or Disperse leases;
- RPC failure;
- degraded broadcast routes;
- worker reconnects and last processed block.

## Verification evidence

- Release commit: `3f23d06`.
- Automated tests: 107 passed, 0 failed.
- ESLint: clean.
- Strict TypeScript and optimized Next.js build: passed.
- Standalone asset preparation: passed.
- Drizzle schema check: passed.
- Full npm dependency tree: valid.
- `npm audit`: 0 vulnerabilities.
- Git diff/whitespace check: passed.
- GitHub CI workflow added for install, tests, lint, build, schema and full audit.
- Production health: HTTP 200, PostgreSQL connected.
- Production role: `combined`, healthy.
- Armed jobs/timers at verification: 0 / 0; missing timers: 0.
- Robinhood provider WebSocket: configured, connected, fresh block, 0 reconnects.
- No transaction was created, queued, signed or broadcast during deployment verification.

## Historical replay

A deterministic fixture replays the Terminal launch from 16:03:45 to 16:04:52 UTC. The V2 modeled path budgets 80ms detection, 80ms pinned state, 60ms fee read, 70ms simulation, 25ms ladder signing and 70ms sequencer acknowledgement: 385ms from opening. This is a regression budget, not a network-inclusion promise. The suite fails if the modeled path exceeds 500ms or if state reads cross block heights.

## Remaining operational constraints

- FCFS success can never be guaranteed.
- Dedicated-worker nonce ladders require the wallet not to be used manually during the launch.
- The current one-service Railway deployment runs `combined` compatibility mode. The code supports dedicated `web` and `worker` services; splitting them is the recommended next infrastructure change when a second Railway service is provisioned.
- Public Robinhood endpoints remain fallbacks. Production speed depends on the configured provider WebSocket and private RPC routes.
- No bulk Disperse contract is active until an independently audited and explorer-verified deployment is approved and its runtime code hash is pinned.
- Real route p50/p95 rankings need future launch samples. The bot now records those samples automatically.

## Primary technical references

- Robinhood Chain connection endpoints: https://docs.robinhood.com/chain/connecting/
- Robinhood FCFS ordering model: https://docs.robinhood.com/chain/
- Robinhood full-node / sequencer-feed guidance: https://docs.robinhood.com/chain/run-a-full-node/
- Ethereum `eth_sendRawTransaction`: https://ethereum.org/developers/docs/apis/json-rpc/
- OpenSea drop mint transaction API: https://docs.opensea.io/docs/mint-from-a-drop

## Final assessment

V2 materially changes the failure profile. MintBot no longer loses seconds to avoidable scheduler sleeps and duplicated reads; no longer waits for receipt N before submitting nonce N+1; no longer hides Disperse errors; and no longer depends on chat memory to onboard known mint types. It is now a reusable, observable, restart-safe transaction engine with explicit safety boundaries.

The correct expectation is not “guaranteed first.” It is: prepare everything safely before the race, react through the fastest reviewed signal, submit through the direct ordering endpoint, explain every millisecond, and never duplicate or silently send funds.
