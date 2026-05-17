# 🪙 NFT Mint Bot

**Multi-chain NFT auto-minting service with web dashboard, Flashbots protection, and FCFS sniping.**

Built for speed. Ships on 7 mainnets + 4 testnets. AES-256 encrypted wallet vault, contract-aware minting, and zero-click FCFS mode.

---

## Features

### 🔐 Wallet Vault
- AES-256-GCM encrypted private key storage
- BIP39 mnemonic import with HD derivation (preview 10 addresses)
- Spend limits per wallet (max ETH cap)
- Balance checks before mint (ETH + ERC20)

### ⛓️ Multi-Chain
- **Mainnets:** Ethereum, Polygon, Arbitrum, Optimism, Base, BNB Chain, Avalanche
- **Testnets:** Sepolia, Polygon Amoy, Base Sepolia, Arbitrum Sepolia
- RPC health dashboard with live latency + failover
- Auto-fallback to public RPCs when Alchemy key not set

### 🚀 Minting Engine
- FCFS 0-click auto-mint (watch contract events → auto-fire)
- Scheduled minting (datetime picker)
- Batch minting across wallets
- Dry-run simulation mode (eth_call, no gas spent)
- Gas presets: Slow / Medium / Fast / Apocalypse
- Per-job gas overrides
- Nonce management with mutex locks
- Retry with exponential backoff
- Cancel stuck transactions (send 0 ETH to self at same nonce)
- Speed-up (1.5x gas replacement)

### 🛡️ MEV Protection
- Flashbots Protect RPC (7 chains)
- Flashbots relay `eth_sendBundle` (mainnet)
- Private mempool submission

### 📜 Smart Contract Tools
- Auto-fetch verified ABI from Etherscan V2 API
- Mint function detection via name heuristics
- FCFS event signature detection (MintOpen, SaleActive, etc.)
- Contract safety scanner (whitelist/blacklist, honeypot detection)
- ERC20 approval handling (approve → mint for USDC/WETH)

### 📊 Dashboard
- Real-time stats (total mints, success rate, gas spent)
- Analytics page with daily breakdowns
- SSE live job updates
- Dark mode throughout

### 🔔 Alerting
- Discord webhook alerts (job failures, RPC down, unstuck events)
- Persistent alert log

### ⚙️ Operations
- Multi-worker scheduler (1-20 concurrent)
- IP whitelist proxy middleware
- Export/import (collections, safety list, config as JSON)
- Health check endpoint (`/api/health`)

---

## Tech Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| Database | PostgreSQL + Drizzle ORM |
| Blockchain | ethers v6 |
| Styling | Tailwind CSS 4 |
| Deployment | Railway |
| Auth | IP whitelist |

---

## Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL
- Alchemy API key (optional, falls back to public RPCs)

### Setup

```bash
git clone https://github.com/hammadbtc/nft-mint-bot.git
cd nft-mint-bot
npm install
```

Create `.env.local`:

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/nftmintbot
VAULT_PASSPHRASE=your-encryption-passphrase
ALCHEMY_API_KEY=optional-but-recommended
```

```bash
# Push database schema
npx drizzle-kit push

# Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Dashboard                   │
│  Wallets │ Collections │ Jobs │ Analytics    │
├─────────────────────────────────────────────┤
│                API Layer (28 routes)          │
│   CRUD │ Mint │ FCFS │ Stats │ Export/Import │
├─────────────────────────────────────────────┤
│              Mint Engine Workers              │
│   Scheduler │ Nonce Mgr │ Retry │ Gas Calc   │
├─────────────────────────────────────────────┤
│                 Blockchain                    │
│   ethers │ Flashbots │ eth_call │ RPC Pool   │
├─────────────────────────────────────────────┤
│                PostgreSQL                     │
│   10 tables: wallets, collections, jobs, etc  │
└─────────────────────────────────────────────┘
```

---

## Security

- Private keys encrypted at rest (AES-256-GCM)
- Passphrase never stored — required at runtime
- IP whitelist middleware for dashboard access
- Contract safety checks before mint
- `.env*` files excluded from git

---

## License

MIT

---

**Built by [@Hammadbtc](https://x.com/hammadbtc)**
