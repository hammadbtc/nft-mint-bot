# MintBot

Focused, single-user NFT mint automation with three workflows: Mints, Wallets and Disperse.

## Product flow

- Paste a supported mint URL, contract address or exact project name.
- Review verified project and phase details.
- Select active main and/or worker wallets and quantity, then mint now or schedule.
- Review per-wallet task status and results.
- Import one main wallet, mint directly from it when desired, or create independent workers beneath it for multi-wallet runs; fund workers and sweep balances back.

Unsupported projects are rejected rather than guessed. Mint and Disperse work can be safely queued while broadcasting is locked; live transactions require both explicit safety gates after verification.

## Stack

- Next.js 16, React 19 and TypeScript
- PostgreSQL with Drizzle ORM
- ethers v6
- AES-256-GCM wallet-secret encryption
- AES-256-GCM signed-transaction encryption at rest

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
npm run test:coverage
npm run build
npx drizzle-kit check
```

See `docs/PRODUCT_AND_AUDIT_HANDOFF.md` for scope, architecture decisions, external requirements and the final High-reasoning audit checklist.

The immutable definition lifecycle is documented in `docs/PHASE_0_1_FOUNDATION.md`; machine certification and atomic activation are documented in `docs/PHASE_2_CERTIFICATION.md`.

Railway setup and the exact environment-variable list are in `docs/RAILWAY_DEPLOYMENT.md`.

The operator workflow for investigating, registering, testing, updating and disabling a supported mint is in `docs/ADDING_A_MINT_PROJECT.md`.

New support drafts default to the strict `reviewed-call-v1` compiler. Its exact calldata bindings and encrypted, job-pinned allowlist/signature workflow are documented in `docs/PHASE_3_4_REVIEWED_EXECUTION.md`.

Launchpad resolvers, exact-intent shadow cutovers, per-wallet readiness and redacted incident replay bundles are documented in `docs/PHASE_5_6_RESOLVERS_AND_CUTOVER.md`.

Supported-project config is draft intake only. New or changed definitions require phase-complete adapter-byte certification, and replacements require a clean atomic shadow cutover before broadcasting can be released.
