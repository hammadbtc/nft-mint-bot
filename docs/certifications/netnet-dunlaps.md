# DUNLAPS mint support certification

## Identity

- Project: DUNLAPS (`netnet-dunlaps`)
- Official mint URL: https://opensea.io/collection/netnet-dunlaps/overview
- Independent official evidence: OpenSea collection/drop data and Robinhood on-chain SeaDrop state
- Chain / chain ID: Robinhood Chain / 4663
- Collection contract: `0xe801b3399193ad1af4e0bbcad72a45c2ff819a8f`
- Router/drop contract: SeaDrop `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`
- Adapter key: `opensea-seadrop-v1`
- Execution engine: `scheduled-public-v1`
- Reviewed commit: working tree before release commit
- Investigator / UTC timestamp: Agent69 / 2026-08-28

## Phase execution matrix

Only the public phase is supported. Earlier Project Mint and Net Net Stakers signed presales are deliberately excluded.

| Phase ID | Kind | Start/end source | Price source | Eligibility source | Armable | Needs provider payload | Payload proves eligibility | Final revalidation | Broadcast mode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| public | public | on-chain `getPublicDrop` | on-chain | on-chain wallet mint stats | yes | no | no | rebuild and compare on-chain intent | identical raw transaction fanout |

## Exact transaction evidence

- Signing wallet used for local certification: ephemeral offline test signer; production wallet rehearsal remains required
- `to`: `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`
- `chainId`: `4663`
- `value`: `2000000000000000` wei per item; two items = `4000000000000000` wei
- Function: `mintPublic(collection, feeRecipient, address(0), quantity)`
- Collection argument: `0xe801b3399193ad1af4e0bbcad72a45c2ff819a8f`
- Fee recipient: `0x0000a26b00c1F0DF003000390027140000fAa719`; confirmed on-chain allowed
- Recipient/minter binding: SeaDrop mints to the payer; delegated-minter argument is zero
- Reviewed pre-open fallback gas limit: 500,000
- Expected pre-open result: `eth_call`/estimate may revert because public mint is not active; deterministic arming remains supported
- Expected live result: exact call succeeds only while time, cap, supply, balance and current configuration pass
- Expected receipt: SeaDrop collection mint/transfer events
- Redacted fixture/test: `tests/netnet-dunlaps-adapter.test.ts`

## Live read-only evidence

- Robinhood block: `48,578,331`
- Chain timestamp: `2026-08-28T20:18:56.000Z`
- Bytecode: 19,658 bytes
- Name/symbol: `DUNLAPS` / `DUNLAPS`
- Supply at review: 229 / 1,105
- Public start/end: `2026-08-28T22:00:00.000Z` / `2026-08-29T04:00:00.000Z`
- Price: 0.002 ETH
- Public wallet cap: 2 (updated on-chain/OpenSea after initial review)
- Fee: 1,000 bps; restricted reviewed fee recipient is allowed
- Batched public RPC read latency observed locally: 1,238 ms

## Automated certification

- Project-specific calldata/value test: `tests/netnet-dunlaps-adapter.test.ts`
- Generic public eligibility, timing, cap, supply and price-change tests: `tests/opensea-seadrop-adapter.test.ts`
- Restart/raw-hash and non-early broadcast coverage: `tests/launch-replay.test.ts`, `tests/launch-timing.test.ts`
- Exact URL/lookalike rejection: project-specific and global matcher tests
- Commands and final results are recorded in the operator handoff.
- `npm run support:certify`: 3/3 passed
- `npm test`: 138/138 passed
- `npm run lint`: passed with zero errors/warnings
- `npm run build`: passed after TypeScript and production route generation
- `npx drizzle-kit check`: passed
- `npm audit --audit-level=high`: zero vulnerabilities

## Production rehearsal

- Offline exact-transaction rehearsal: passed with ephemeral signer, chain 4663, selector `0x161ac21f`, 247 raw bytes, and raw hash equality
- Pre-open `eth_call`: correctly rejected with SeaDrop `NotActive(uint256,uint256,uint256)` (`0x13da22f2`)
- Pre-open `eth_estimateGas`: correctly rejected with the same time-gate error; reviewed 500,000 gas fallback applies
- Robinhood public RPC, 12 uncached block reads: 119.7 ms minimum, 124.7 ms p50, 313.1 ms p95/max
- Official sequencer: write-only as expected; read health is not inferred from unsupported read methods
- Wallet-authenticated production arming: pending deployment, seed and operator-selected vault wallets
- Broadcast: prohibited during certification; no transaction submitted

## Release decision

- Decision: blocked until the deployed production job reaches `armed` with persisted raw bytes/hash
- Remaining risks: public FCFS can sell out; production RPC/WebSocket health and wallet funding must pass immediately before launch
- UTC timestamp: 2026-08-28
