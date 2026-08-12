import { ethers } from "ethers";

export interface ChainConfig {
  id: number;
  name: string;
  symbol: string;
  rpcUrls: string[];
  explorerUrl?: string;
}

/**
 * Build RPC URL list for a chain. Alchemy URLs are only included when
 * ALCHEMY_API_KEY is set; otherwise they are dropped and public fallbacks
 * become the primary.
 */
function rpc(...urls: (string | false)[]): string[] {
  return urls.filter((u): u is string => !!u);
}

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
const HAS_ALCHEMY = !!(ALCHEMY_KEY && ALCHEMY_KEY.length > 10);
const al = (path: string) => HAS_ALCHEMY ? `https://${path}.g.alchemy.com/v2/${ALCHEMY_KEY}` : false;

const CHAINS: Record<number, ChainConfig> = {
  4663: {
    id: 4663,
    name: "Robinhood Chain",
    symbol: "ETH",
    rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
    explorerUrl: "https://robinhoodchain.blockscout.com",
  },
  1: {
    id: 1,
    name: "Ethereum",
    symbol: "ETH",
    rpcUrls: rpc(al("eth-mainnet"), "https://eth.llamarpc.com", "https://rpc.ankr.com/eth"),
    explorerUrl: "https://etherscan.io",
  },
  137: {
    id: 137,
    name: "Polygon",
    symbol: "MATIC",
    rpcUrls: rpc(al("polygon-mainnet"), "https://polygon.llamarpc.com", "https://rpc.ankr.com/polygon"),
    explorerUrl: "https://polygonscan.com",
  },
  42161: {
    id: 42161,
    name: "Arbitrum",
    symbol: "ETH",
    rpcUrls: rpc(al("arb-mainnet"), "https://arb1.arbitrum.io/rpc"),
    explorerUrl: "https://arbiscan.io",
  },
  10: {
    id: 10,
    name: "Optimism",
    symbol: "ETH",
    rpcUrls: rpc(al("opt-mainnet"), "https://mainnet.optimism.io"),
    explorerUrl: "https://optimistic.etherscan.io",
  },
  8453: {
    id: 8453,
    name: "Base",
    symbol: "ETH",
    rpcUrls: rpc(al("base-mainnet"), "https://mainnet.base.org"),
    explorerUrl: "https://basescan.org",
  },
  56: {
    id: 56,
    name: "BNB Chain",
    symbol: "BNB",
    rpcUrls: ["https://bsc-dataseed.binance.org", "https://bsc-dataseed1.defibit.io", "https://rpc.ankr.com/bsc"],
    explorerUrl: "https://bscscan.com",
  },
  43114: {
    id: 43114,
    name: "Avalanche C-Chain",
    symbol: "AVAX",
    rpcUrls: ["https://api.avax.network/ext/bc/C/rpc", "https://rpc.ankr.com/avalanche"],
    explorerUrl: "https://snowtrace.io",
  },
  // ─── Testnets ─────────────────────────────────────────────────────
  11155111: {
    id: 11155111,
    name: "Sepolia (Testnet)",
    symbol: "sETH",
    rpcUrls: rpc(al("eth-sepolia"), "https://rpc.sepolia.org", "https://sepolia.gateway.tenderly.co"),
    explorerUrl: "https://sepolia.etherscan.io",
  },
  80002: {
    id: 80002,
    name: "Polygon Amoy (Testnet)",
    symbol: "MATIC",
    rpcUrls: rpc(al("polygon-amoy"), "https://rpc-amoy.polygon.technology"),
    explorerUrl: "https://amoy.polygonscan.com",
  },
  84532: {
    id: 84532,
    name: "Base Sepolia (Testnet)",
    symbol: "sETH",
    rpcUrls: rpc(al("base-sepolia"), "https://sepolia.base.org"),
    explorerUrl: "https://sepolia.basescan.org",
  },
  421614: {
    id: 421614,
    name: "Arbitrum Sepolia (Testnet)",
    symbol: "sETH",
    rpcUrls: rpc(al("arb-sepolia"), "https://sepolia-rollup.arbitrum.io/rpc"),
    explorerUrl: "https://sepolia.arbiscan.io",
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
