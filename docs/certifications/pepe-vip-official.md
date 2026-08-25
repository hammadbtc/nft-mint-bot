# Pepe VIP mint support certification

## Identity

- Project: Pepe VIP
- Official mint URL: https://opensea.io/collection/pepe-vip-official/overview
- Independent official announcement: blocked; OpenSea links `@PepeVIPnft`, but no separate announcement was available during the launch window
- Chain / chain ID: Robinhood Chain / 4663
- Collection contract: `0x14044a824c814eba2757a5d99643ec6aafbda771`
- Router/drop/minter contract: SeaDrop `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`
- Adapter key: `opensea-signed-seadrop-v1`
- Execution engine: `scheduled-server-signed-v1`
- Reviewed commit: pending commit containing this certification
- Investigator / UTC timestamp: Agent69 / 2026-08-25 21:47 UTC

## Phase execution matrix

| Phase ID | Kind | Start/end source | Price source | Eligibility source | Armable | Needs provider payload | Payload proves eligibility | Final revalidation | Broadcast mode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `vip-list-fcfs` | signed presale | OpenSea drop plus decoded successful mint | OpenSea wallet-bound signed payload | OpenSea wallet eligibility and signed payload | yes | yes | yes | cached signed intent, signer, nonce, funds and supply | identical persisted bytes over Robinhood routes |
| `public` | public sale | OpenSea plus on-chain `getPublicDrop` | on-chain `getPublicDrop` | on-chain wallet mint stats | yes | no | no | fresh public drop, fee recipient, wallet cap, supply, signer, nonce and funds | identical persisted bytes over Robinhood routes |

The signed payload is bound to the collection, quantity, stage index, stage
window, price, supply cap, fee and restricted-recipient rule. The observed
payload expires with the signed phase at 2026-08-25 22:00:03 UTC. Earliest
successful acquisition was not measured with a MintBot vault wallet.

## Exact transaction evidence

- Signing wallet address used for certification: ephemeral unfunded wallet for offline public arming; successful signed-phase transaction used only as a redacted public-chain fixture
- `from`: ephemeral wallet / observed signed minter, not retained
- `to`: `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`
- `chainId`: 4663
- `value`: signed phase `0`; public phase `500000000000000` wei per token
- Function selector and decoded arguments: signed `0x4b61cd6f` `mintSigned(collection, OpenSea feeRecipient, zero recipient, 1, [0,1,1787688003,1787695203,1,10000,1000,true], salt, signature)`; public `mintPublic(collection, OpenSea feeRecipient, zero recipient, quantity)`
- Recipient/minter binding: zero delegated recipient, so NFT returns to payer/signer
- Fee recipient and permission: `0x0000a26b00c1F0DF003000390027140000fAa719`; confirmed in the on-chain allowed list
- Gas-estimation or reviewed pre-open gas limit: adapter conservative limit `500000`; observed signed mint used 153,726 gas
- Expected pre-open result: normal public execution rejects before start; reviewed arming path may sign with `allowBeforeStart`
- Expected live simulation result: exact public intent is simulated with the signing wallet immediately before execution
- Expected events/receipt: successful SeaDrop mint and ERC-721 transfer to the payer
- Redacted fixture/test location: `tests/pepe-vip-adapter.test.ts`

## Automated certification

- Project-specific calldata/value test: passed
- Eligibility positive/negative/unknown tests: passed in shared OpenSea adapter suite
- Before/during/after phase tests: passed in shared phase/launch suites
- Wallet cap, supply, pause, price-change tests: passed in shared SeaDrop suite
- Signed/public mixed-adapter regression: passed
- Restart/raw-hash recovery test: passed in shared launch-replay/mainnet-safety suites
- Exact URL/lookalike rejection test: passed
- `npm run support:certify`: passed, 3/3
- `npm test`: passed, 128/128
- `npm run lint`: passed
- `npm run build`: passed from an isolated build copy because the data volume cannot hold local dependencies
- `npx drizzle-kit check`: passed
- `npm audit`: passed, 0 vulnerabilities

## Production rehearsal

- Deployed commit from `/api/health`: blocked pending deployment
- DB and scheduler healthy: blocked pending deployment check
- HTTPS RPC providers and observed latency: official Robinhood RPC read succeeded; production redundancy pending status check
- WebSocket providers configured: blocked pending authenticated production status
- Wallet-authenticated eligibility result: blocked; no vault wallet rehearsal performed
- Job ID / dry-run or controlled rehearsal mode: blocked
- Phase selected by server: blocked
- Payload warmed when required: blocked for a real vault wallet
- Persisted raw transaction/hash verified: passed offline for public phase; blocked in production DB
- Status reached `armed` before launch: blocked
- Launch and revalidation timers present: covered by automated tests; blocked in production
- WebSocket demand active while launch-critical: covered by automated tests; blocked in production
- Restart restoration tested or covered by exact fixture: covered by exact fixture
- Broadcast disabled/controlled as intended: no transaction was broadcast during certification
- Errors and redacted telemetry reviewed: no secret material was logged or committed

## Release decision

- Decision: `blocked`
- Remaining risks: OpenSea collection is unverified; independent official announcement and wallet-authenticated production arming rehearsal are absent
- Operator approval: Hammad requested addition; this is not equivalent to transaction certification
- UTC timestamp: 2026-08-25 21:52 UTC
