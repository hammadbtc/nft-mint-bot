# Railway deployment

## Railway project layout

Create two services in one Railway project:

1. A PostgreSQL database named `Postgres`.
2. The MintBot application connected to this GitHub repository.

Keep the MintBot service at exactly **one replica**. Database claims and nonce reservations are concurrency-safe, but one embedded scheduler keeps operations and observability simple.

`railway.json` configures Railpack, one replica, the production build, pre-deploy environment validation/schema sync, `/api/health`, and restart-on-failure behavior. Generate a public domain for the MintBot service after the first successful deployment.

## Required variables

Add these to the MintBot service:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
VAULT_PASSPHRASE=<64 random hex characters or stronger>
APP_ACCESS_USER=mintbot
APP_ACCESS_PASSWORD=<strong password, at least 16 characters>
SUPPORT_ADMIN_TOKEN=<64 random hex characters or stronger>
ENABLE_LIVE_TRANSACTIONS=false
```

Use Railway's **Add Reference Variable** UI for `DATABASE_URL`; do not copy the public database URL. Railway supplies `PORT` automatically—do not set it yourself.

Generate independent secrets locally:

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -base64 24
```

Use the first hex value for `VAULT_PASSPHRASE`, the second for `SUPPORT_ADMIN_TOKEN`, and the Base64 value for `APP_ACCESS_PASSWORD`.

Never change `VAULT_PASSPHRASE` after wallets have been imported or generated; changing it makes existing encrypted keys unreadable. Store it outside Railway as a secure backup.

## Recommended variables

```env
ALCHEMY_API_KEY=<Alchemy key>
ROBINHOOD_DRPC_URL=<full private Robinhood mainnet HTTPS endpoint>
ROBINHOOD_QUICKNODE_URL=<full private Robinhood mainnet HTTPS endpoint>
ROBINHOOD_CHAINSTACK_URL=<full private Robinhood mainnet HTTPS endpoint when available>
ROBINHOOD_RPC_URLS=<optional comma-separated independent HTTPS providers>
```

Named endpoints are used for both read failover and concurrent same-hash writes and appear by provider name in latency telemetry. Never commit their URLs: provider credentials are commonly embedded in the URL path or query string. The app also has a public fallback, but private providers are strongly recommended for live FCFS minting.

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

## Troubleshooting

- `Environment validation failed`: a required variable is absent or too short.
- Health check returns 503: `DATABASE_URL` is wrong or PostgreSQL is unavailable.
- Browser repeatedly asks for login: check `APP_ACCESS_USER` and `APP_ACCESS_PASSWORD` on the app service.
- Existing wallets no longer decrypt: `VAULT_PASSPHRASE` changed; restore the original value.
- Deployment has no styling/assets: verify the build log includes `Standalone static and public assets prepared`.
