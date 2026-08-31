# Railway deployment

## Railway project layout

The V2 layout uses three services in one Railway project:

1. A PostgreSQL database named `Postgres`.
2. A MintBot web service connected to this GitHub repository, with
   `MINTBOT_EXECUTION_ROLE=web` and the normal `npm start` command.
3. A MintBot execution worker connected to the same commit and database, with
   `MINTBOT_EXECUTION_ROLE=worker` and `npm run worker` as its start command.

Keep the execution worker at exactly **one replica**. The web service never
starts a scheduler in `web` mode; it reads the worker's durable database
heartbeat. This prevents web deploys, page traffic, and health probes from
competing with launch execution. `combined` remains the compatibility default
for a one-service migration, but it is not the final V2 production layout.

`railway.json` configures Railpack, one replica, the production build, pre-deploy environment validation/schema sync, `/api/health`, and restart-on-failure behavior. Generate a public domain for the MintBot service after the first successful deployment.

Predeploy runs the regression gates and database hardening before supported-project drafts are staged. A phase-capability contradiction, unregistered adapter, invalid execution manifest, malformed signed stage, or mixed signed/public classification error must fail deployment and leave the previous production release active. Staging is intake-only: it cannot overwrite live execution fields, certify, activate, or release a project.

## Required variables

Add these to the MintBot service:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
# Use combined for one Railway service. Use web/worker only for a split deployment.
MINTBOT_EXECUTION_ROLE=combined
VAULT_PASSPHRASE=<64 random hex characters or stronger>
APP_ACCESS_USER=mintbot
APP_ACCESS_PASSWORD=<strong password, at least 16 characters>
SUPPORT_ADMIN_TOKEN=<64 random hex characters or stronger>
CERTIFICATION_ATTESTATION_KEY=<64 random hex characters or stronger>
# Optional separate confirmation secret for destructive UI actions.
# If omitted, the existing APP_ACCESS_PASSWORD is used.
ADMIN_ACTION_PASSWORD=<strong password, at least 16 characters>
ENABLE_LIVE_TRANSACTIONS=false
```

Use Railway's **Add Reference Variable** UI for `DATABASE_URL`; do not copy the public database URL. Railway supplies `PORT` automatically—do not set it yourself.

Generate independent secrets locally:

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -base64 24
```

Use the first hex value for `VAULT_PASSPHRASE`, the second for `SUPPORT_ADMIN_TOKEN`, the third for `CERTIFICATION_ATTESTATION_KEY`, and the Base64 value for `APP_ACCESS_PASSWORD`.

`ADMIN_ACTION_PASSWORD` is optional. Set it when wallet/task deletion and wallet signing-key replacement should use a secret separate from the browser login. When it is blank, those confirmations use `APP_ACCESS_PASSWORD`.

Never change `VAULT_PASSPHRASE` after wallets have been imported or generated; changing it makes existing encrypted keys unreadable. Store it outside Railway as a secure backup.

The first hardened rollout encrypts any persisted mint and Disperse signed payloads before either service starts. Historical database backups taken before that rollout may still contain broadcastable raw transactions; retain or expire those backups according to the secret-backup policy, and keep broadcasting paused until both web and worker run the hardened commit.

That rollout also pauses collections whose only authority is a legacy deploy-time seed certificate. This does not fail infrastructure health while the collection is safely paused, but the collection cannot schedule, execute, or be released until `support:certify-definition` produces a fresh certificate for the deployed commit.

## Recommended variables

```env
ALCHEMY_API_KEY=<Alchemy key>
OPENSEA_API_KEY=<permanent OpenSea server API key for signed drops>
ROBINHOOD_QUICKNODE_URL=<full private Robinhood mainnet HTTPS endpoint>
ROBINHOOD_CHAINSTACK_URL=<full private Robinhood mainnet HTTPS endpoint when available>
ROBINHOOD_RPC_URLS=<optional comma-separated independent HTTPS providers>
ROBINHOOD_WS_URLS=<optional comma-separated additional WebSocket providers>
ROBINHOOD_DRPC_WS_URL=<optional independent dRPC WebSocket endpoint>
ROBINHOOD_QUICKNODE_WS_URL=<optional independent QuickNode WebSocket endpoint>
ROBINHOOD_CHAINSTACK_WS_URL=<optional independent Chainstack WebSocket endpoint>
```

Named endpoints are used for both read failover and concurrent same-hash writes and appear by provider name in latency telemetry. Robinhood provider order is Alchemy first, QuickNode second, additional configured routes next, and the official public HTTPS RPC last. The public endpoint does not provide the launch WebSocket subscription. Quota and rate-limit responses temporarily quarantine only the affected HTTPS route. Never commit provider URLs: credentials are commonly embedded in the path or query string. Only configure a dRPC URL when the account has an actual Robinhood endpoint; an account balance without Robinhood network access is not usable.

When live transactions are enabled, environment validation and readiness require at least two independent WebSocket providers, and readiness requires at least two healthy HTTPS routes for every active chain. Intentional WebSocket idle remains healthy only outside launch demand; lack of configured redundancy does not.

## Demand-aware WebSocket usage

The scheduler remains online continuously, but the paid `newHeads` WebSocket subscription does not. Every 30 seconds the worker reconciles persisted mint jobs:

- no live launch-critical jobs: disconnect intentionally and remain healthy;
- a non-dry-run pending job reaches T-60 minutes: connect;
- a pending job has no authoritative launch time: connect as a fail-safe;
- an `armed`, `running`, or `confirming` job: stay connected until terminal;
- several jobs: disconnect only after all launch-critical work is terminal.

This state is derived from PostgreSQL, so a worker restart inside the one-hour window reconnects automatically. A database error also fails toward launch safety by connecting. Intentional idle is accounted for by the aggregate `/api/health` result and is reported separately in authenticated `/api/status` diagnostics.

Use the per-chain `<CHAIN>_RPC_URLS` variables from `.env.example` for independent HTTPS routes on Ethereum, Polygon, Arbitrum, Optimism, Base, BNB Chain, and Avalanche. Before launch, run `npm run rpc:check`; it performs only `eth_chainId` and `eth_blockNumber` reads and never signs or broadcasts a transaction.

`OPENSEA_API_KEY` is strongly recommended when a reviewed collection uses `opensea-signed-seadrop-v1`. The server authenticates selected vault wallets, encrypts reusable OpenSea wallet credentials in PostgreSQL using the vault encryption boundary, and reads stage eligibility without constructing a mint transaction. Wallet-bound signed mint data is requested only when preparing execution. If the permanent key is absent, the server may use OpenSea's official instant-key flow as a launch fallback; it is not a durable substitute for the permanent key.

## Optional variables

```env
DISCORD_WEBHOOK_URL=<private Discord webhook>
ALLOWED_IPS=<comma-separated IPs>
```

`ALLOWED_IPS` is an alternative to `APP_ACCESS_PASSWORD`, not normally needed in addition to it. Basic Auth is easier if your IP changes.

## Live transaction gate

Keep these values during UI and preview testing:

```env
ENABLE_LIVE_TRANSACTIONS=false
LIVE_TRANSACTIONS_CONFIRMED=
```

Only after a successful testnet mint and Disperse test should they become:

```env
ENABLE_LIVE_TRANSACTIONS=true
LIVE_TRANSACTIONS_CONFIRMED=I_UNDERSTAND
```

Scheduling and Disperse queueing remain available while this gate is locked. The scheduler holds non-dry-run work; both mint and Disperse use the same two-key broadcast gate. Do not fund wallets before testnet verification.

## Deploy steps

1. Push the repository changes to GitHub.
2. Create a Railway project and add PostgreSQL.
3. Add the GitHub repository as a service.
4. Add the required reference variable and secrets above.
5. Confirm the service uses `railway.json` from the repository root.
6. Deploy and wait for the pre-deploy schema sync and `/api/health` check.
7. Generate a Railway domain.
8. Open the domain and sign in with `APP_ACCESS_USER` / `APP_ACCESS_PASSWORD`.
9. Keep one replica and live transactions disabled until testnet validation.

For every newly supported live mint, verify the deployed commit in authenticated `/api/status`, complete `docs/MINT_SUPPORT_CERTIFICATION_TEMPLATE.md`, and inspect the intended jobs. `/api/health` intentionally exposes only aggregate status, service, and version. A scheduled competitive launch is not ready until each intended job is `armed`, its encrypted signed transaction and public hash are persisted, timers are present, the worker heartbeat is fresh, and WebSocket demand is active. Public health with zero armed jobs is evidence of infrastructure health only, not launch certification.

## Troubleshooting

- `Environment validation failed`: a required variable is absent or too short.
- Health check returns 503: `DATABASE_URL` is wrong or PostgreSQL is unavailable.
- Browser repeatedly asks for login: check `APP_ACCESS_USER` and `APP_ACCESS_PASSWORD` on the app service.
- Existing wallets no longer decrypt: `VAULT_PASSPHRASE` changed; restore the original value.
- Deployment has no styling/assets: verify the build log includes `Standalone static and public assets prepared`.
