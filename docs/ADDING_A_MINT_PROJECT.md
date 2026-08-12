# Adding a supported mint project

This is the operator workflow for making a mint URL searchable in MintBot. Users never fill these technical fields; a project is reviewed and registered before they paste its link.

## Golden rule

Never register a project from an unverified link or guessed ABI. Confirm the official website and announcements, inspect the deployed contract, verify every mint phase, and simulate the exact transaction before enabling it.

An unsupported URL must remain unsupported until this process is complete.

## Two kinds of support

### Reusable launchpad adapter

Use this when a launchpad has a stable documented protocol shared across projects, such as a standard marketplace/launchpad contract and API. One adapter can resolve multiple projects, but every collection still gets its own verified record containing its official domain, contract and phase configuration.

Do not assume all projects on a launchpad use the same transaction. Check contract/version, delegated contracts, server signatures, allowlist proofs, payment tokens and mint phases.

### Custom project adapter

Use this for personal mint websites or unusual contracts. It may need custom argument construction, an allowlist API, a signed payload, delegated minting, ERC-20 approval or another project-specific step.

Custom adapters belong under `src/lib/adapters/`. Register the adapter key in `src/lib/adapters/index.ts` and add tests before registering the project.

## Information needed from Hammad

For each upcoming mint, collect:

- Official mint URL.
- Official project X/Discord announcement confirming that URL.
- Network and expected launch time with timezone.
- Public or allowlist phase being targeted.
- Desired wallet count and quantity per wallet.
- Any allowlist CSV, proof endpoint, access token or signature flow.

Never paste private wallet keys into a project-support request.

## Investigation checklist

1. Confirm the domain is official through at least one independent official project channel.
2. Record redirects and the final canonical hostname.
3. Identify the launchpad and its deployed version, or classify it as custom.
4. Determine the actual mint contract and verify bytecode exists on the expected chain.
5. Obtain the verified ABI from the block explorer or project source.
6. Identify the exact mint function and every argument in order.
7. Determine native-token or ERC-20 payment and whether approval is needed.
8. Verify price, maximum per wallet, supply, phase start/end and timezone.
9. Determine allowlist eligibility, Merkle proof or server-signature requirements.
10. Verify whether quantity, recipient address or referrer changes transaction calldata.
11. Reproduce the site transaction locally without sending it.
12. Run `eth_call`/gas estimation from an eligible test address where possible.
13. Add adapter fixtures and tests.
14. Register the project as verified only after all checks pass.

## Project registration format

Registration uses `POST /api/collections`. The application is protected by HTTP Basic Auth, and registration additionally requires the `X-Support-Admin-Token` header.

Example configuration:

```json
{
  "name": "Example Collection",
  "slug": "example-collection",
  "contractAddress": "0x0000000000000000000000000000000000000001",
  "chainId": 1,
  "mintMethod": "mint",
  "mintAbi": [
    {
      "type": "function",
      "name": "mint",
      "stateMutability": "payable",
      "inputs": [{ "name": "quantity", "type": "uint256" }],
      "outputs": []
    }
  ],
  "mintPrice": "10000000000000000",
  "maxPerWallet": 2,
  "maxSupply": 10000,
  "adapterKey": "evm-contract-v1",
  "domains": ["mint.example.com"],
  "siteUrl": "https://mint.example.com",
  "imageUrl": "https://mint.example.com/project.jpg",
  "adapterConfig": {
    "phases": [
      {
        "id": "public",
        "name": "Public",
        "startsAt": "2026-08-20T18:00:00.000Z",
        "endsAt": "2026-08-21T18:00:00.000Z",
        "priceWei": "10000000000000000",
        "maxPerWallet": 2
      }
    ]
  },
  "verified": true
}
```

Amounts such as `mintPrice` and `priceWei` are integer base units represented as strings. Never use decimal ETH values in these fields.

Register it from a trusted machine:

```bash
curl --fail-with-body \
  --user "$APP_ACCESS_USER:$APP_ACCESS_PASSWORD" \
  -H "Content-Type: application/json" \
  -H "X-Support-Admin-Token: $SUPPORT_ADMIN_TOKEN" \
  --data @project.json \
  "https://YOUR-RAILWAY-DOMAIN/api/collections"
```

Do not commit `project.json` if it contains private API credentials or allowlist secrets.

## Current generic adapter limitation

`evm-contract-v1` currently supports the simple transaction shape already handled by the mint engine: a payable mint function called with `quantity`, falling back to no arguments. It is suitable only when that exact behavior has been verified.

It is **not** sufficient for:

- Merkle proofs.
- Server-generated signatures.
- Multiple structured arguments or tuples.
- Delegated mint contracts.
- Captchas or authenticated project APIs.
- Dutch auctions whose price must be read at execution time.
- Contracts where recipient/referrer/value logic differs.

Those projects require a purpose-built adapter and transaction builder before registration. Do not force them into the generic adapter.

## Verification after registration

1. Keep `ENABLE_LIVE_TRANSACTIONS=false`.
2. Paste the official URL into the MintBot UI.
3. Confirm the correct name, domain, chain, contract, phase, price, supply and limits appear.
4. Confirm a lookalike subdomain and an unrelated path/domain remain unsupported.
5. Import throwaway testnet wallets under a testnet main wallet.
6. Run a dry-run mint and inspect the exact calldata/value/gas result.
7. Confirm ineligible, underfunded and wrong-network wallets fail before broadcast.
8. Test idempotency by repeating the same submission and confirming no duplicate task.
9. Restart the Railway service with a scheduled test task and confirm recovery.
10. Enable live transactions only for a funded testnet end-to-end test.

## Updating or disabling support

`POST /api/collections` performs an upsert when the same project `id` is supplied. Keep the project ID from the initial response when applying reviewed changes.

There is intentionally no public UI for editing project support. Emergency disabling should be performed directly in PostgreSQL until a dedicated operator command exists:

```sql
UPDATE collections SET active = false WHERE id = 'PROJECT_UUID';
```

Disable a project immediately if its domain, contract, phase configuration, proof/signature endpoint or official announcement changes unexpectedly. Re-run the full checklist before enabling it again.

## Pre-mainnet approval checklist

- Official domain independently confirmed.
- Correct chain and deployed contract confirmed.
- ABI and function signature verified.
- Transaction arguments and value reproduced exactly.
- Phase timing and timezone checked twice.
- Eligibility/proof/signature flow tested.
- Wrong-network and insufficient-balance failures tested.
- Exact transaction simulated.
- Testnet or fork test passed.
- No secrets appear in logs or committed files.
- Hammad reviewed the loaded UI details.
- Live enablement is an explicit final action, never part of registration.
