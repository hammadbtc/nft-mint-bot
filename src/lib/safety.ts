import { createHash, timingSafeEqual } from "node:crypto";

const SECRET_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{20,}/g,
  /0x[a-fA-F0-9]{64}/g,
  /(https?:\/\/[^\s/:]+:)[^@\s]+@/g,
  /([?&](?:api_?key|dkey|token|secret|password)=)[^&\s]+/gi,
  /(\/v2\/)[A-Za-z0-9_-]{16,}/g,
  /(\.quiknode\.pro\/)[A-Za-z0-9_-]{16,}/gi,
  /(\.core\.chainstack\.com\/)[A-Za-z0-9_-]{16,}/gi,
];

export function liveTransactionsEnabled(): boolean {
  // Fail closed after the 2026-08-28 operator emergency stop. Re-enabling
  // broadcasting requires an additional, deliberate deployment-time override.
  return process.env.MINTBOT_EMERGENCY_STOP === "CLEARED_BY_OPERATOR"
    && process.env.ENABLE_LIVE_TRANSACTIONS === "true"
    && process.env.LIVE_TRANSACTIONS_CONFIRMED === "I_UNDERSTAND";
}

export function requireLiveTransactions(): void {
  if (!liveTransactionsEnabled()) {
    throw new Error("Live transactions are disabled until both production safety gates are enabled");
  }
}

export function safeErrorMessage(error: unknown, fallback = "Operation failed"): string {
  let message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : fallback;

  for (const pattern of SECRET_PATTERNS) {
    message = message.replace(pattern, (_match, prefix?: string) => `${prefix || ""}[REDACTED]`);
  }
  return message.slice(0, 1_000) || fallback;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function safeSecretEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isPermanentMintError(message: string): boolean {
  return /not supported|disabled|wrong network|mint wallet|worker wallet|quantity|mint has ended|mint has not started|wallet limit|remaining supply|insufficient|spend limit|invalid|not found|inactive|simulation failed/i.test(message);
}
