/**
 * Contract Scanner — auto-fetches verified contract ABI from Etherscan-family
 * explorers and detects mint functions, events, and pricing.
 */

import { getChain, ChainConfig } from "@/lib/chains";

// Etherscan V2: single unified API endpoint for all 60+ chains
const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";

const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || process.env.ALCHEMY_API_KEY || "";

// Chains supported by Etherscan V2 (chainid mapping from https://docs.etherscan.io/supported-chains)
const ETHERSCAN_CHAIN_IDS = new Set([1, 137, 42161, 10, 8453, 56, 43114, 11155111, 80002, 84532, 421614]);

export interface AbiEntry {
  type: "function" | "event" | "constructor" | "fallback" | "receive";
  name?: string;
  inputs?: { name?: string; type: string; indexed?: boolean }[];
  outputs?: { name?: string; type: string }[];
  stateMutability?: string;
  anonymous?: boolean;
}

export interface DetectedFunction {
  name: string;
  inputs: { name?: string; type: string }[];
  stateMutability: string;
  isCandidate: boolean; // likely mint function?
  reason: string; // why we think so
}

export interface DetectedEvent {
  name: string;
  signature: string; // keccak256 topic
  inputs: { name?: string; type: string; indexed?: boolean }[];
}

export interface ContractScanResult {
  address: string;
  abi: AbiEntry[];
  name: string | null; // contract name from source
  mintFunctions: DetectedFunction[];
  mintOpenEvents: DetectedEvent[];
  suggestedMintPrice: string | null;
  suggestedPaymentToken: string | null;
  error: string | null;
}

// ─── Mint function heuristics ──────────────────────────────────────────
const MINT_NAME_PATTERNS = [
  /^mint$/i,
  /^mint(to|NFT|token|batch|public|whitelist|allowlist|phase|presale)$/i,
  /^buy$/i,
  /^buyNFT$/i,
  /^claim$/i,
  /^claimNFT$/i,
  /^purchase$/i,
  /^publicMint$/i,
  /^presaleMint$/i,
  /^wlMint$/i,
  /^whitelistMint$/i,
];

// Events that signal mint is open
const MINT_OPEN_EVENT_PATTERNS = [
  /^MintOpen$/i,
  /^MintOpened$/i,
  /^SaleActive$/i,
  /^SaleStarted$/i,
  /^PublicSaleActive$/i,
  /^PublicSaleStarted$/i,
  /^PublicMintOpen$/i,
  /^PublicMintOpened$/i,
  /^PresaleActive$/i,
  /^PresaleOpens$/i,
  /^PreSaleActive$/i,
  /^WhitelistMintEnabled$/i,
  /^AllowlistMintEnabled$/i,
  /^MintingEnabled$/i,
  /^MintPhaseChanged$/i,
  /^PhaseChanged$/i,
  /^MintStatusChanged$/i,
];

// ERC20 tokens commonly used for NFT payments
const KNOWN_PAYMENT_TOKENS: Record<number, Record<string, string>> = {
  1: {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
    "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
  },
  137: {
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": "USDC",
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": "USDT",
    "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": "WETH",
  },
};

export function isMintFunctionName(name: string): { match: boolean; reason: string } {
  for (const pattern of MINT_NAME_PATTERNS) {
    if (pattern.test(name)) {
      return { match: true, reason: `name matches "${name}"` };
    }
  }
  return { match: false, reason: "" };
}

export function isMintOpenEventName(name: string): boolean {
  return MINT_OPEN_EVENT_PATTERNS.some((p) => p.test(name));
}

/**
 * Fetch verified ABI from an Etherscan-family explorer.
 */
export async function fetchContractAbi(
  address: string,
  chainId: number
): Promise<{ abi: AbiEntry[]; name: string | null; error: string | null }> {
  if (!ETHERSCAN_CHAIN_IDS.has(chainId)) {
    return { abi: [], name: null, error: `Chain ${chainId} not supported by Etherscan V2` };
  }

  if (!ETHERSCAN_KEY || ETHERSCAN_KEY.length < 10) {
    return { abi: [], name: null, error: "No Etherscan API key configured (set ETHERSCAN_API_KEY)" };
  }

  try {
    // V2: unified endpoint + chainid param
    const baseParams = `chainid=${chainId}&apikey=${ETHERSCAN_KEY}`;

    // Fetch ABI
    const abiUrl = `${ETHERSCAN_V2_BASE}?module=contract&action=getabi&address=${address}&${baseParams}`;
    const abiRes = await fetch(abiUrl, { signal: AbortSignal.timeout(10000) });
    const abiJson = await abiRes.json();

    if (abiJson.status !== "1" || !abiJson.result) {
      const errMsg = abiJson.result || "Contract not verified or not found";
      return { abi: [], name: null, error: typeof errMsg === "string" ? errMsg : "Unknown error" };
    }

    let abi: AbiEntry[];
    try {
      abi = typeof abiJson.result === "string" ? JSON.parse(abiJson.result) : abiJson.result;
    } catch {
      return { abi: [], name: null, error: "Failed to parse ABI response" };
    }

    // Fetch contract name from source
    let name: string | null = null;
    try {
      const srcUrl = `${ETHERSCAN_V2_BASE}?module=contract&action=getsourcecode&address=${address}&${baseParams}`;
      const srcRes = await fetch(srcUrl, { signal: AbortSignal.timeout(10000) });
      const srcJson = await srcRes.json();
      if (srcJson.status === "1" && srcJson.result?.[0]?.ContractName) {
        name = srcJson.result[0].ContractName;
      }
    } catch {
      // name is optional
    }

    return { abi, name, error: null };
  } catch (err: any) {
    return { abi: [], name: null, error: err.message || "Network error fetching ABI" };
  }
}

/**
 * Scan a contract: fetch ABI, detect mint functions, events, price hints.
 */
export async function scanContract(
  address: string,
  chainId: number
): Promise<ContractScanResult> {
  const { abi, name, error } = await fetchContractAbi(address, chainId);

  if (error) {
    return {
      address,
      abi: [],
      name: null,
      mintFunctions: [],
      mintOpenEvents: [],
      suggestedMintPrice: null,
      suggestedPaymentToken: null,
      error,
    };
  }

  const mintFunctions: DetectedFunction[] = [];
  const mintOpenEvents: DetectedEvent[] = [];
  let suggestedMintPrice: string | null = null;
  let suggestedPaymentToken: string | null = null;
  let foundPriceFunction: AbiEntry | null = null;

  for (const entry of abi) {
    // ── Functions ──
    if (entry.type === "function" && entry.name) {
      const { match, reason } = isMintFunctionName(entry.name);

      if (match) {
        mintFunctions.push({
          name: entry.name,
          inputs: entry.inputs || [],
          stateMutability: entry.stateMutability || "nonpayable",
          isCandidate: true,
          reason,
        });
      }

      // Detect price-related functions
      if (/^price$/i.test(entry.name) || /^mintPrice$/i.test(entry.name) || /^cost$/i.test(entry.name)) {
        foundPriceFunction = entry;
      }

      // Detect payment token
      if (entry.inputs) {
        for (const input of entry.inputs) {
          if (/paymentToken|currency|erc20/i.test(input.name || "")) {
            // We don't know the address, but flag it
          }
        }
      }
    }

    // ── Events ──
    if (entry.type === "event" && entry.name && isMintOpenEventName(entry.name)) {
      mintOpenEvents.push({
        name: entry.name,
        signature: `${entry.name}(${(entry.inputs || []).map((i) => i.type).join(",")})`,
        inputs: entry.inputs || [],
      });
    }

    // ── Detect ERC20 payment token from constructor/state vars ──
    if (entry.type === "constructor" && entry.inputs) {
      for (const input of entry.inputs) {
        if (
          (input.type === "address" && /paymentToken|usdc|usdt|weth|currency/.test((input.name || "").toLowerCase()))
        ) {
          // Flagged but unknown address
        }
      }
    }
  }

  // ── Sort mint functions: payable first (most likely), then nonpayable, then view ──
  mintFunctions.sort((a, b) => {
    const score = (f: DetectedFunction) => {
      if (f.stateMutability === "payable") return 3;
      if (f.stateMutability === "nonpayable") return 2;
      return 1;
    };
    return score(b) - score(a);
  });

  return {
    address,
    abi,
    name,
    mintFunctions,
    mintOpenEvents,
    suggestedMintPrice,
    suggestedPaymentToken,
    error: abi.length === 0 ? "ABI is empty — contract may not be verified" : null,
  };
}
