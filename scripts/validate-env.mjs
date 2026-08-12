const required = ["DATABASE_URL", "VAULT_PASSPHRASE", "SUPPORT_ADMIN_TOKEN"];
const missing = required.filter((name) => !process.env[name]?.trim());

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

if (process.env.ENABLE_LIVE_TRANSACTIONS === "true" && process.env.LIVE_TRANSACTIONS_CONFIRMED !== "I_UNDERSTAND") {
  console.error("Live transactions require LIVE_TRANSACTIONS_CONFIRMED=I_UNDERSTAND");
  process.exit(1);
}

console.log("Environment validation passed");
