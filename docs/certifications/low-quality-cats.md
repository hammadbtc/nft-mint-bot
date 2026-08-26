# Low Quality Cats mint support certification

## Identity

- Project: Low Quality Cats
- Official mint URL: https://opensea.io/collection/low-quality-cats/overview
- Independent official announcement: OpenSea live/upcoming Drops listing and collection page
- Chain / chain ID: Ethereum / 1
- Collection contract: `0x55afd2187d7c312bf7e4ca7393a139df19f1f096`
- Router/drop/minter contract: SeaDrop `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`
- Adapter key: `opensea-signed-seadrop-v1`
- Execution engine: `scheduled-server-signed-v1`
- Reviewed commit: working tree before release commit
- Investigator / UTC timestamp: Agent69 / 2026-08-26

## Phase execution matrix

| Phase ID | Kind | Start/end source | Price source | Eligibility source | Armable | Needs provider payload | Payload proves eligibility | Final revalidation | Broadcast mode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| team | signed | OpenSea drop | signed payload | OpenSea wallet payload | yes | yes | yes | exact decoded payload | raw public RPC fanout |
| gtd | signed | OpenSea drop | signed payload | OpenSea wallet payload | yes | yes | yes | exact decoded payload | raw public RPC fanout |
| fcfs | signed | OpenSea + observed tx | signed payload | OpenSea wallet payload | yes | yes | yes | exact decoded payload | raw public RPC fanout |
| public | public | on-chain `getPublicDrop` | on-chain | on-chain wallet mint stats | yes | no | no | rebuild and compare on-chain intent | raw public RPC fanout |

## Exact transaction evidence

- Signing wallet address used for certification: redacted observed mainnet FCFS minter; public dry run uses a non-broadcast test address
- `to`: `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`
- `chainId`: `1`
- Public `value`: `5000000000000000` wei per item
- Public function: `mintPublic(collection, feeRecipient, address(0), quantity)`
- Signed FCFS selector: `0x4b61cd6f`; decoded observed transaction fixture is in `tests/low-quality-cats-adapter.test.ts`
- Fee recipient: `0x0000a26b00c1F0DF003000390027140000fAa719`, on-chain allowed
- Reviewed pre-open gas limit: 500,000
- Expected pre-open result: simulation may revert on time; deterministic arming uses reviewed gas limit
- Expected live result: exact public calldata/value passes if wallet cap and supply remain
- Expected event: collection mint/transfer events emitted by SeaDrop collection

## Automated certification

- Project-specific calldata/value test: `tests/low-quality-cats-adapter.test.ts`
- Signed/public mixed-adapter regression: covered
- Exact URL/lookalike rejection: covered by global matcher tests
- Remaining command results are recorded in the release handoff.

## Production rehearsal

- Wallet-authenticated production arming: blocked until the project is deployed/seeded and an operator selects funded vault wallets
- Broadcast: disabled during local dry run; no transaction was submitted

## Release decision

- Decision: blocked pending deployment and wallet-authenticated production arming
- Remaining risks: public phase is competitive and may sell out; local environment has no production secrets or Railway access
- UTC timestamp: 2026-08-26
