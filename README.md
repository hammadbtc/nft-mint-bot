# MintBot

Focused, single-user NFT mint automation with three workflows: Mints, Wallets and Disperse.

## Product flow

- Paste a supported mint URL, contract address or exact project name.
- Review verified project and phase details.
- Select worker wallets and quantity, then mint now or schedule.
- Review per-wallet task status and results.
- Import one main wallet, create independent workers beneath it, fund workers and sweep balances back.

Unsupported projects are rejected rather than guessed. Mint and Disperse work can be safely queued while broadcasting is locked; live transactions require both explicit safety gates after verification.

## Stack

- Next.js 16, React 19 and TypeScript
- PostgreSQL with Drizzle ORM
- ethers v6
- AES-256-GCM wallet-secret encryption

## Local setup

```bash
cp .env.example .env.local
npm install
npx drizzle-kit push
npm run dev
```

`VAULT_PASSPHRASE` must contain at least 32 characters. Production also requires Basic Auth or `ALLOWED_IPS`, plus a separate `SUPPORT_ADMIN_TOKEN` for reviewed mint registration.

## Checks

```bash
npm run lint
npm test
npm run build
npx drizzle-kit check
```

See `docs/PRODUCT_AND_AUDIT_HANDOFF.md` for scope, architecture decisions, external requirements and the final High-reasoning audit checklist.

Railway setup and the exact environment-variable list are in `docs/RAILWAY_DEPLOYMENT.md`.

The operator workflow for investigating, registering, testing, updating and disabling a supported mint is in `docs/ADDING_A_MINT_PROJECT.md`.
