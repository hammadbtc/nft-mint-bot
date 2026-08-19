const chains = [
  { id: 4663, name: "Robinhood", env: "ROBINHOOD_RPC_URLS", named: ["ROBINHOOD_DRPC_URL", "ROBINHOOD_QUICKNODE_URL", "ROBINHOOD_CHAINSTACK_URL"], public: "https://rpc.mainnet.chain.robinhood.com" },
  { id: 1, name: "Ethereum", env: "ETHEREUM_RPC_URLS" },
  { id: 137, name: "Polygon", env: "POLYGON_RPC_URLS" },
  { id: 42161, name: "Arbitrum", env: "ARBITRUM_RPC_URLS" },
  { id: 10, name: "Optimism", env: "OPTIMISM_RPC_URLS" },
  { id: 8453, name: "Base", env: "BASE_RPC_URLS" },
  { id: 56, name: "BNB Chain", env: "BNB_RPC_URLS" },
  { id: 43114, name: "Avalanche", env: "AVALANCHE_RPC_URLS" },
];

const list = (name) => (process.env[name] || "").split(",").map((value) => value.trim()).filter(Boolean);
const label = (raw) => {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (host.endsWith("alchemy.com")) return "Alchemy";
    if (host.endsWith("drpc.org")) return "dRPC";
    if (host.endsWith("quiknode.pro")) return "QuickNode";
    if (host.endsWith("chainstack.com")) return "Chainstack";
    if (host.includes("robinhood.com")) return "Robinhood public RPC";
  } catch {}
  return "Custom RPC";
};

async function call(url, method) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }), signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok || body.error || !body.result) throw new Error(body.error?.message || `HTTP ${response.status}`);
    return body.result;
  } finally { clearTimeout(timer); }
}

let failed = false;
for (const chain of chains) {
  const urls = [...new Set([...(chain.named || []).flatMap(list), ...list(chain.env), ...(chain.public ? [chain.public] : [])])];
  if (!urls.length) continue;
  for (const url of urls) {
    const started = performance.now();
    try {
      const [chainId, block] = await Promise.all([call(url, "eth_chainId"), call(url, "eth_blockNumber")]);
      if (Number(BigInt(chainId)) !== chain.id) throw new Error(`wrong chain ${Number(BigInt(chainId))}`);
      console.log(`PASS ${chain.name} / ${label(url)} / block ${Number(BigInt(block))} / ${Math.round(performance.now() - started)}ms`);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${chain.name} / ${label(url)} / ${error instanceof Error ? error.message : "unavailable"}`);
    }
  }
}
if (failed) process.exitCode = 1;
