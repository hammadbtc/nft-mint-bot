const required = ["DATABASE_URL", "VAULT_PASSPHRASE", "SUPPORT_ADMIN_TOKEN"];
const missing = required.filter((name) => !process.env[name]?.trim());

const executionRole = (process.env.MINTBOT_EXECUTION_ROLE || "combined").trim().toLowerCase();
if (!["web", "worker", "combined"].includes(executionRole)) {
  console.error("MINTBOT_EXECUTION_ROLE must be web, worker, or combined");
  process.exit(1);
}

if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

if (process.env.VAULT_PASSPHRASE.length < 32) {
  console.error("VAULT_PASSPHRASE must be at least 32 characters");
  process.exit(1);
}

if (process.env.SUPPORT_ADMIN_TOKEN.length < 32) {
  console.error("SUPPORT_ADMIN_TOKEN must be at least 32 characters");
  process.exit(1);
}

if (!process.env.APP_ACCESS_PASSWORD?.trim() && !process.env.ALLOWED_IPS?.trim()) {
  console.error("Set APP_ACCESS_PASSWORD or ALLOWED_IPS so production access fails closed");
  process.exit(1);
}

if (process.env.APP_ACCESS_PASSWORD && process.env.APP_ACCESS_PASSWORD.length < 16) {
  console.error("APP_ACCESS_PASSWORD must be at least 16 characters");
  process.exit(1);
}

if (process.env.ADMIN_ACTION_PASSWORD && process.env.ADMIN_ACTION_PASSWORD.length < 16) {
  console.error("ADMIN_ACTION_PASSWORD must be at least 16 characters");
  process.exit(1);
}

if (process.env.ENABLE_LIVE_TRANSACTIONS === "true" && process.env.LIVE_TRANSACTIONS_CONFIRMED !== "I_UNDERSTAND") {
  console.error("Live transactions require LIVE_TRANSACTIONS_CONFIRMED=I_UNDERSTAND");
  process.exit(1);
}

const namedRobinhoodRpcUrls = ["ROBINHOOD_DRPC_URL", "ROBINHOOD_QUICKNODE_URL", "ROBINHOOD_CHAINSTACK_URL"]
  .map((name) => process.env[name]?.trim())
  .filter(Boolean);
const robinhoodRpcUrls = [
  ...namedRobinhoodRpcUrls,
  ...(process.env.ROBINHOOD_RPC_URLS || "").split(",").map((value) => value.trim()).filter(Boolean),
];
for (const value of robinhoodRpcUrls) {
  try {
    if (new URL(value).protocol !== "https:") throw new Error();
  } catch {
    console.error("Every ROBINHOOD_RPC_URLS entry must be a valid HTTPS URL");
    process.exit(1);
  }
}

const robinhoodWebSocketUrls = [
  "ROBINHOOD_QUICKNODE_WS_URL", "ROBINHOOD_CHAINSTACK_WS_URL", "ROBINHOOD_WS_URLS", "ROBINHOOD_WS_URL", "ROBINHOOD_DRPC_WS_URL",
].flatMap((name) => (process.env[name] || "").split(",").map((value) => value.trim()).filter(Boolean));
for (const value of robinhoodWebSocketUrls) {
  try {
    if (new URL(value).protocol !== "wss:") throw new Error();
  } catch {
    console.error("Every Robinhood WebSocket endpoint must be a valid wss:// URL");
    process.exit(1);
  }
}

if (process.env.ENABLE_LIVE_TRANSACTIONS === "true" && !process.env.ALCHEMY_API_KEY?.trim() && robinhoodRpcUrls.length === 0) {
  console.error("Live Robinhood operation requires ALCHEMY_API_KEY or a second HTTPS endpoint in ROBINHOOD_RPC_URLS");
  process.exit(1);
}

const liveWebSocketProviderCount = new Set([
  ...(process.env.ALCHEMY_API_KEY?.trim() ? ["alchemy"] : []),
  ...robinhoodWebSocketUrls,
]).size;
if (process.env.ENABLE_LIVE_TRANSACTIONS === "true" && liveWebSocketProviderCount < 2) {
  console.error("Live Robinhood operation requires at least two independent WebSocket providers");
  process.exit(1);
}

console.log("Environment validation passed");
