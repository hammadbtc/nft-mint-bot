import { ethers } from "ethers";

export interface ChainConfig {
  id: number;
  name: string;
  symbol: string;
  rpcUrls: string[];
  explorerUrl?: string;
}

export interface BroadcastRoute {
  key: string;
  label: string;
  url: string;
}

/**
 * Build RPC URL list for a chain. Alchemy URLs are only included when
 * ALCHEMY_API_KEY is set; otherwise they are dropped and public fallbacks
 * become the primary.
 */
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
const HAS_ALCHEMY = !!(ALCHEMY_KEY && ALCHEMY_KEY.length > 10);
const al = (path: string) => HAS_ALCHEMY ? `https://${path}.g.alchemy.com/v2/${ALCHEMY_KEY}` : false;

function envRpcList(name: string): string[] {
  return (process.env[name] || "").split(",").map((value) => value.trim()).filter(Boolean);
}

function configuredRpcList(prefix: string): string[] {
  return envRpcList(`${prefix}_RPC_URLS`);
}

function envRpc(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function uniqueRpc(...urls: (string | false | undefined)[]): string[] {
  return [...new Set(urls.filter((value): value is string => Boolean(value)))];
}

const CHAINS: Record<number, ChainConfig> = {
  4663: {
    id: 4663,
    name: "Robinhood Chain",
    symbol: "ETH",
    rpcUrls: uniqueRpc(
      al("robinhood-mainnet"),
      envRpc("ROBINHOOD_QUICKNODE_URL"),
      envRpc("ROBINHOOD_CHAINSTACK_URL"),
      ...envRpcList("ROBINHOOD_RPC_URLS"),
      envRpc("ROBINHOOD_DRPC_URL"),
      "https://rpc.mainnet.chain.robinhood.com",
    ),
    explorerUrl: "https://robinhoodchain.blockscout.com",
  },
  1: {
    id: 1,
    name: "Ethereum",
    symbol: "ETH",
    rpcUrls: uniqueRpc(al("eth-mainnet"), ...configuredRpcList("ETHEREUM")),
    explorerUrl: "https://etherscan.io",
  },
  137: {
    id: 137,
    name: "Polygon",
    symbol: "MATIC",
    rpcUrls: uniqueRpc(al("polygon-mainnet"), ...configuredRpcList("POLYGON"), "https://polygon.llamarpc.com", "https://rpc.ankr.com/polygon"),
    explorerUrl: "https://polygonscan.com",
  },
  42161: {
    id: 42161,
    name: "Arbitrum",
    symbol: "ETH",
    rpcUrls: uniqueRpc(al("arb-mainnet"), ...configuredRpcList("ARBITRUM"), "https://arb1.arbitrum.io/rpc"),
    explorerUrl: "https://arbiscan.io",
  },
  10: {
    id: 10,
    name: "Optimism",
    symbol: "ETH",
    rpcUrls: uniqueRpc(al("opt-mainnet"), ...configuredRpcList("OPTIMISM"), "https://mainnet.optimism.io"),
    explorerUrl: "https://optimistic.etherscan.io",
  },
  8453: {
    id: 8453,
    name: "Base",
    symbol: "ETH",
    rpcUrls: uniqueRpc(al("base-mainnet"), ...configuredRpcList("BASE"), "https://mainnet.base.org"),
    explorerUrl: "https://basescan.org",
  },
  56: {
    id: 56,
    name: "BNB Chain",
    symbol: "BNB",
    rpcUrls: uniqueRpc(...configuredRpcList("BNB"), "https://bsc-dataseed.binance.org", "https://bsc-dataseed1.defibit.io", "https://rpc.ankr.com/bsc"),
    explorerUrl: "https://bscscan.com",
  },
  43114: {
    id: 43114,
    name: "Avalanche C-Chain",
    symbol: "AVAX",
    rpcUrls: uniqueRpc(...configuredRpcList("AVALANCHE"), "https://api.avax.network/ext/bc/C/rpc", "https://rpc.ankr.com/avalanche"),
    explorerUrl: "https://snowtrace.io",
  },
  // ─── Testnets ─────────────────────────────────────────────────────
  11155111: {
    id: 11155111,
    name: "Sepolia (Testnet)",
    symbol: "sETH",
    rpcUrls: uniqueRpc(al("eth-sepolia"), ...configuredRpcList("SEPOLIA"), "https://rpc.sepolia.org", "https://sepolia.gateway.tenderly.co"),
    explorerUrl: "https://sepolia.etherscan.io",
  },
  80002: {
    id: 80002,
    name: "Polygon Amoy (Testnet)",
    symbol: "MATIC",
    rpcUrls: uniqueRpc(al("polygon-amoy"), ...configuredRpcList("POLYGON_AMOY"), "https://rpc-amoy.polygon.technology"),
    explorerUrl: "https://amoy.polygonscan.com",
  },
  84532: {
    id: 84532,
    name: "Base Sepolia (Testnet)",
    symbol: "sETH",
    rpcUrls: uniqueRpc(al("base-sepolia"), ...configuredRpcList("BASE_SEPOLIA"), "https://sepolia.base.org"),
    explorerUrl: "https://sepolia.basescan.org",
  },
  421614: {
    id: 421614,
    name: "Arbitrum Sepolia (Testnet)",
    symbol: "sETH",
    rpcUrls: uniqueRpc(al("arb-sepolia"), ...configuredRpcList("ARBITRUM_SEPOLIA"), "https://sepolia-rollup.arbitrum.io/rpc"),
    explorerUrl: "https://sepolia.arbiscan.io",
  },
};

// ─── Provider management ──────────────────────────────────────────────

// In-memory provider cache
const providerCache = new Map<string, ethers.JsonRpcProvider>();
const failoverProviderCache = new Map<number, ethers.FallbackProvider>();
const rpcQuarantineUntil = new Map<string, number>();
const RPC_QUARANTINE_MS = 60_000;
const RPC_HEALTH_CACHE_MS = 15_000;

export function rpcQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /\b429\b|too many requests|rate.?limit|compute units?|monthly capacity|quota|capacity exceeded|limit exceeded/i.test(message);
}

export function quarantineRpcUrl(url: string, now = Date.now()): void {
  rpcQuarantineUntil.set(url, now + RPC_QUARANTINE_MS);
}

export function rpcUrlQuarantined(url: string, now = Date.now()): boolean {
  const until = rpcQuarantineUntil.get(url) || 0;
  if (until <= now) {
    rpcQuarantineUntil.delete(url);
    return false;
  }
  return true;
}

export function clearRpcQuarantine(): void {
  rpcQuarantineUntil.clear();
}

class RateAwareJsonRpcProvider extends ethers.JsonRpcProvider {
  constructor(request: ethers.FetchRequest, chainId: number, private readonly rpcUrl: string) {
    super(request, chainId, { staticNetwork: true, batchMaxCount: 1 });
  }

  override async _send(payload: ethers.JsonRpcPayload | Array<ethers.JsonRpcPayload>): Promise<Array<ethers.JsonRpcResult>> {
    if (rpcUrlQuarantined(this.rpcUrl)) throw new Error("RPC route is temporarily quarantined after a quota or rate-limit response");
    try {
      return await super._send(payload);
    } catch (error) {
      if (rpcQuotaError(error)) quarantineRpcUrl(this.rpcUrl);
      throw error;
    }
  }
}

function providerForUrl(url: string, chainId: number): ethers.JsonRpcProvider {
  const request = new ethers.FetchRequest(url);
  request.timeout = 12_000;
  return new RateAwareJsonRpcProvider(request, chainId, url);
}

/**
 * Get a provider for a chain. Tries primary RPC first, falls back to alternates.
 * Caches the working provider.
 */
export function getProvider(chainId: number): ethers.Provider {
  return getFailoverProvider(chainId);
}

export function getPrimaryProvider(chainId: number): ethers.JsonRpcProvider {
  const cacheKey = `chain-${chainId}`;
  if (providerCache.has(cacheKey)) {
    return providerCache.get(cacheKey)!;
  }

  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unknown chain ID: ${chainId}`);

  // Use first (primary) RPC URL
  const provider = providerForUrl(chain.rpcUrls[0], chainId);

  providerCache.set(cacheKey, provider);
  return provider;
}

/**
 * Get a provider with built-in failover across all configured RPCs.
 */
export function getFailoverProvider(chainId: number): ethers.FallbackProvider {
  const cached = failoverProviderCache.get(chainId);
  if (cached) return cached;
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unknown chain ID: ${chainId}`);

  const providers = chain.rpcUrls.map((url, index) => ({
    provider: providerForUrl(url, chainId),
    priority: index + 1,
    weight: 1,
    stallTimeout: 1_000,
  }));

  const provider = new ethers.FallbackProvider(providers, undefined, { quorum: 1 });
  failoverProviderCache.set(chainId, provider);
  return provider;
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
 * Independent write routes for latency-sensitive submission. Robinhood's
 * official sequencer is deliberately first, followed by every configured RPC.
 * Callers must send identical signed bytes to every route.
 */
export function getBroadcastRoutes(chainId: number): BroadcastRoute[] {
  const chain = getChain(chainId);
  const candidates = chainId === 4663
    ? [process.env.ROBINHOOD_SEQUENCER_URL || "https://sequencer.mainnet.chain.robinhood.com", ...chain.rpcUrls]
    : chain.rpcUrls;
  return [...new Set(candidates)].map((url, index) => {
    const fallbackNumber = index + (chainId === 4663 ? 0 : 1);
    const identified = identifyRpcProvider(url);
    return {
      key: chainId === 4663 && index === 0 ? "sequencer" : identified?.key || `rpc-${fallbackNumber}`,
      label: chainId === 4663 && index === 0 ? "Robinhood sequencer" : identified?.label || `RPC route ${fallbackNumber}`,
      url,
    };
  });
}

export function identifyRpcProvider(rawUrl: string): { key: string; label: string } | undefined {
  let hostname = "";
  try { hostname = new URL(rawUrl).hostname.toLowerCase(); } catch { return undefined; }
  if (hostname.endsWith("alchemy.com")) return { key: "alchemy", label: "Alchemy" };
  if (hostname === "lb.drpc.org" || hostname.endsWith(".drpc.org") || hostname === "lb.drpc.live" || hostname.endsWith(".drpc.live")) return { key: "drpc", label: "dRPC" };
  if (hostname.endsWith("quiknode.pro")) return { key: "quicknode", label: "QuickNode" };
  if (hostname.endsWith("chainstack.com")) return { key: "chainstack", label: "Chainstack" };
  if (hostname === "rpc.mainnet.chain.robinhood.com") return { key: "robinhood-public", label: "Robinhood public RPC" };
  return undefined;
}

function routeIdentity(url: string, index: number): { key: string; label: string } {
  return identifyRpcProvider(url) || { key: `rpc-${index + 1}`, label: `RPC route ${index + 1}` };
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
export type RpcHealthResult = {
  key: string;
  label: string;
  status: "up" | "down" | "quarantined";
  latencyMs: number | null;
};

const rpcHealthCache = new Map<number, { at: number; value: RpcHealthResult[] }>();

export function clearRpcHealthCache(): void {
  rpcHealthCache.clear();
}

export async function checkRpcHealth(chainId: number, now = Date.now()): Promise<RpcHealthResult[]> {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unknown chain ID: ${chainId}`);
  const cached = rpcHealthCache.get(chainId);
  if (cached && now - cached.at < RPC_HEALTH_CACHE_MS) return cached.value;

  const results = await Promise.allSettled(
    chain.rpcUrls.map(async (url, index) => {
      const identity = routeIdentity(url, index);
      if (rpcUrlQuarantined(url, now)) return { ...identity, status: "quarantined" as const, latencyMs: null };
      const start = Date.now();
      const provider = providerForUrl(url, chainId);
      await provider.getBlockNumber();
      return { ...identity, status: "up" as const, latencyMs: Date.now() - start };
    })
  );

  const value: RpcHealthResult[] = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { ...routeIdentity(chain.rpcUrls[i], i), status: "down" as const, latencyMs: null }
  );
  rpcHealthCache.set(chainId, { at: now, value });
  return value;
}
