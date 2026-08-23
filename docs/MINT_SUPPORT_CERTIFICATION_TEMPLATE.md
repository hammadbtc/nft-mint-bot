# Mint support certification

This document is the mandatory evidence record for enabling a project. Replace every placeholder. Use `blocked` when evidence cannot be obtained; never convert blocked evidence into an assumption.

## Identity

- Project:
- Official mint URL:
- Independent official announcement:
- Chain / chain ID:
- Collection contract:
- Router/drop/minter contract:
- Adapter key:
- Execution engine:
- Reviewed commit:
- Investigator / UTC timestamp:

## Phase execution matrix

Complete one row per phase shown by MintBot.

| Phase ID | Kind | Start/end source | Price source | Eligibility source | Armable | Needs provider payload | Payload proves eligibility | Final revalidation | Broadcast mode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  |  |

Rules:

- Signed phases must identify the official payload endpoint, wallet/quantity/phase binding, expiry, signature validation, and earliest successful acquisition time.
- Public phases in mixed adapters must explicitly show that no signed payload is requested and that calldata/value come from current on-chain public-drop state.
- Unsupported phases must remain visible only as unsupported and must never be routed to another phase silently.

## Exact transaction evidence

- Signing wallet address used for certification:
- `from`:
- `to`:
- `chainId`:
- `value`:
- Function selector and decoded arguments:
- Recipient/minter binding:
- Fee recipient and permission:
- Gas-estimation or reviewed pre-open gas limit:
- Expected pre-open result:
- Expected live simulation result:
- Expected events/receipt:
- Redacted fixture/test location:

## Automated certification

- Project-specific calldata/value test:
- Eligibility positive/negative/unknown tests:
- Before/during/after phase tests:
- Wallet cap, supply, pause, price-change tests:
- Signed/public mixed-adapter regression:
- Restart/raw-hash recovery test:
- Exact URL/lookalike rejection test:
- `npm run support:certify`:
- `npm test`:
- `npm run lint`:
- `npm run build`:
- `npx drizzle-kit check`:
- `npm audit`:

## Production rehearsal

- Deployed commit from `/api/health`:
- DB and scheduler healthy:
- HTTPS RPC providers and observed latency:
- WebSocket providers configured:
- Wallet-authenticated eligibility result:
- Job ID / dry-run or controlled rehearsal mode:
- Phase selected by server:
- Payload warmed when required:
- Persisted raw transaction/hash verified:
- Status reached `armed` before launch:
- Launch and revalidation timers present:
- WebSocket demand active while launch-critical:
- Restart restoration tested or covered by exact fixture:
- Broadcast disabled/controlled as intended:
- Errors and redacted telemetry reviewed:

## Release decision

- Decision: `certified` / `blocked` / `rejected`
- Remaining risks:
- Operator approval:
- UTC timestamp:

`certified` is forbidden while any applicable field above is blank, assumed, or blocked.
