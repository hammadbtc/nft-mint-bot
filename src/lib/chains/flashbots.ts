import { ethers } from "ethers";

/**
 * Flashbots relay endpoints.
 * Mainnet: https://relay.flashbots.net
 * Sepolia: https://relay-sepolia.flashbots.net
 * Base/Arbitrum etc: use Flashbots Protect RPC instead
 */
const FLASHBOTS_RELAY_URLS: Record<number, string> = {
  1: "https://relay.flashbots.net",
  11155111: "https://relay-sepolia.flashbots.net",
  // Other chains: use Protect RPC
};

const FLASHBOTS_PROTECT_RPC: Record<number, string> = {
  1: "https://rpc.flashbots.net",
  137: "https://polygon.rpc.flashbots.net",
  42161: "https://arbitrum.rpc.flashbots.net",
  10: "https://optimism.rpc.flashbots.net",
  8453: "https://base.rpc.flashbots.net",
  56: "https://bsc.rpc.flashbots.net",
};

/**
 * Send a private transaction via Flashbots Protect RPC.
 * This is the simplest integration — just use their RPC endpoint
 * and the tx is protected from frontrunning.
 */
export async function sendPrivateTransaction(
  chainId: number,
  signedTx: string
): Promise<ethers.TransactionResponse> {
  const protectRpc = FLASHBOTS_PROTECT_RPC[chainId];
  if (!protectRpc) {
    throw new Error(`Flashbots Protect not available for chain ${chainId}`);
  }

  const provider = new ethers.JsonRpcProvider(protectRpc, chainId, {
    staticNetwork: true,
    batchMaxCount: 1,
  });

  const tx = await provider.broadcastTransaction(signedTx);
  return tx as unknown as ethers.TransactionResponse;
}

/**
 * Send via Flashbots relay using eth_sendBundle (MEV protection).
 * Requires an auth signer (any wallet with ETH) to sign the bundle.
 */
export async function sendFlashbotsBundle(
  chainId: number,
  signedTx: string,
  authSigner: ethers.Wallet,
  targetBlock?: number
): Promise<{ bundleHash: string }> {
  const relayUrl = FLASHBOTS_RELAY_URLS[chainId];
  if (!relayUrl) {
    throw new Error(`Flashbots relay not available for chain ${chainId}`);
  }

  if (!targetBlock) {
    if (!authSigner.provider) {
      throw new Error("Flashbots auth signer has no provider — connect it first");
    }
    const currentBlock = await authSigner.provider.getBlockNumber();
    targetBlock = currentBlock + 1;
  }

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendBundle",
    params: [
      {
        txs: [signedTx],
        blockNumber: ethers.toBeHex(targetBlock),
      },
    ],
  };

  const signature = `${authSigner.address}:${await authSigner.signMessage(
    ethers.id(JSON.stringify(body))
  )}`;

  const resp = await fetch(relayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Flashbots-Signature": signature,
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (data.error) {
    throw new Error(`Flashbots bundle error: ${data.error.message}`);
  }

  return { bundleHash: data.result.bundleHash };
}

/**
 * Check if Flashbots Protect is available for a chain.
 */
export function hasFlashbotsProtect(chainId: number): boolean {
  return chainId in FLASHBOTS_PROTECT_RPC;
}

/**
 * Check if Flashbots relay (bundle) is available for a chain.
 */
export function hasFlashbotsRelay(chainId: number): boolean {
  return chainId in FLASHBOTS_RELAY_URLS;
}
