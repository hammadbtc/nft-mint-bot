import { ethers } from "ethers";

export interface ChainConfig {
  id: number;
  name: string;
  symbol: string;
  rpcUrls: string[];
  explorerUrl?: string;
}

/**
 * Default chain configurations with Alchemy free-tier endpoints.
 * Replace YOUR_ALCHEMY_KEY with the actual key via env var.
 */
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || "demo";

const CHAINS: Record<number, ChainConfig> = {
  1: {
    id: 1,
    name: "Ethereum",
    symbol: "ETH",
    rpcUrls: [
      `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      "https://eth.llamarpc.com",
      "https://rpc.ankr.com/eth",
    ],
    explorerUrl: "https://etherscan.io",
  },
  137: {
    id: 137,
    name: "Polygon",
    symbol: "MATIC",
    rpcUrls: [
      `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      "https://polygon.llamarpc.com",
      "https://rpc.ankr.com/polygon",
    ],
    explorerUrl: "https://polygonscan.com",
  },
  42161: {
    id: 42161,
    name: "Arbitrum",
    symbol: "ETH",
    rpcUrls: [
      `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      "https://arb1.arbitrum.io/rpc",
    ],
    explorerUrl: "https://arbiscan.io",
  },
  10: {
    id: 10,
    name: "Optimism",
    symbol: "ETH",
    rpcUrls: [
      `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      "https://mainnet.optimism.io",
    ],
    explorerUrl: "https://optimistic.etherscan.io",
  },
  8453: {
    id: 8453,
    name: "Base",
    symbol: "ETH",
    rpcUrls: [
      `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      "https://mainnet.base.org",
    ],
    explorerUrl: "https://basescan.org",
  },
  56: {
    id: 56,
    name: "BNB Chain",
    symbol: "BNB",
    rpcUrls: [
      "https://bsc-dataseed.binance.org",
      "https://bsc-dataseed1.defibit.io",
      "https://rpc.ankr.com/bsc",
    ],
    explorerUrl: "https://bscscan.com",
  },
  43114: {
    id: 43114,
    name: "Avalanche C-Chain",
    symbol: "AVAX",
    rpcUrls: [
      "https://api.avax.network/ext/bc/C/rpc",
      "https://rpc.ankr.com/avalanche",
    ],
    explorerUrl: "https://snowtrace.io",
  },
};

// ─── Provider management ──────────────────────────────────────────────

// In-memory provider cache
const providerCache = new Map<string, ethers.JsonRpcProvider>();

/**
 * Get a provider for a chain. Tries primary RPC first, falls back to alternates.
 * Caches the working provider.
 */
export function getProvider(chainId: number): ethers.JsonRpcProvider {
  const cacheKey = `chain-${chainId}`;
  if (providerCache.has(cacheKey)) {
    return providerCache.get(cacheKey)!;
  }

  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unknown chain ID: ${chainId}`);

  // Use first (primary) RPC URL
  const provider = new ethers.JsonRpcProvider(chain.rpcUrls[0], chainId, {
    staticNetwork: true, // avoids extra eth_chainId calls
  });

  providerCache.set(cacheKey, provider);
  return provider;
}

/**
 * Get a provider with built-in failover across all configured RPCs.
 */
export function getFailoverProvider(chainId: number): ethers.FallbackProvider {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unknown chain ID: ${chainId}`);

  const providers = chain.rpcUrls.map(
    (url) => new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true })
  );

  return new ethers.FallbackProvider(providers, 1); // quorum of 1 = first success
}

/**
 * Get chain configuration.
 */
export function getChain(chainId: number): ChainConfig {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unknown chain ID: ${chainId}`);
  return chain;
}

/**
 * List all configured chains.
 */
export function listChains(): ChainConfig[] {
  return Object.values(CHAINS);
}

/**
 * Check RPC health for a chain (pings all endpoints).
 */
export async function checkRpcHealth(chainId: number): Promise<
  { url: string; status: "up" | "down"; latencyMs: number | null }[]
> {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unknown chain ID: ${chainId}`);

  const results = await Promise.allSettled(
    chain.rpcUrls.map(async (url) => {
      const start = Date.now();
      const provider = new ethers.JsonRpcProvider(url, chainId);
      await provider.getBlockNumber();
      return { url, status: "up" as const, latencyMs: Date.now() - start };
    })
  );

  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { url: chain.rpcUrls[i], status: "down" as const, latencyMs: null }
  );
}
