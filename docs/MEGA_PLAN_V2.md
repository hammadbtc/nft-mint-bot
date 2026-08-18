# MintBot Mega Plan V2

This document is the durable implementation and release checklist for the V2
transaction engine. A capability is not complete merely because code exists;
it must be wired into production, observable, tested, and included in the
release audit.

## Acceptance criteria

- [x] Project manifests select a validated reusable execution engine.
- [x] Existing projects migrate without changing reviewed transaction intent.
- [x] Dashboard and transaction execution have explicit web/worker roles with
      a durable cross-process heartbeat and a compatibility migration mode.
- [x] Scheduled public mints can be prepared before launch and fired by a
      precise timer without launch-time estimation or database discovery.
- [x] Signed/allowlist stages pre-authenticate and warm wallet-bound payloads as
      early as their provider permits.
- [x] Stealth stages use an event/WebSocket-capable watcher with a bounded HTTP
      fallback and one pinned-block final safety snapshot.
- [x] One-per-transaction wallet allowances can use a pre-signed nonce ladder
      and broadcast entries without waiting for prior receipts.
- [x] Robinhood submission is sequencer-first with concurrent identical-hash
      fallbacks and route latency telemetry.
- [x] Supply-aware policy suppresses transactions that are no longer safe and
      records why each transaction was not sent.
- [x] Mint, Disperse, and sweep have independent execution capacity.
- [x] Disperse/sweep expose operation and transfer states, exact errors,
      transaction hashes, recovery, and safe retry of never-broadcast work.
- [x] Bulk funding has an audited/verified-contract requirement and never
      silently falls back to an unreviewed contract.
- [x] Every hot-path stage records monotonic and wall-clock timing suitable for
      launch replay and p50/p95 analysis.
- [x] Dashboard health detects dead workers, stale watchers, absent launch
      timers, stuck jobs, and degraded broadcast routes.
- [x] Historical launch replay and deterministic integration tests cover timed,
      signed, stealth, nonce-ladder, restart, RPC inconsistency, and sellout.
- [x] Production migration, seed, test, lint, build, dependency audit, health,
      and dead-code/config audit all pass.
- [ ] Before/after PDF report is generated from verified release evidence and
      sent to the operator on Discord.

## Release rule

No live transaction behavior is enabled by default merely because V2 code has
landed. High-risk modes such as nonce locking, pre-signing, shotgun broadcast,
and bulk Disperse require explicit operator opt-in and fail closed when their
preconditions are not met.
