import { randomUUID } from "node:crypto";
import { ethers } from "ethers";
import { db, schema } from "@/lib/db";
import { getBroadcastRoutes, quarantineRpcUrl, rpcQuotaError, rpcUrlQuarantined, type BroadcastRoute } from "@/lib/chains";
import { safeErrorMessage } from "@/lib/safety";

const ROUTE_TIMEOUT_MS = 4_000;

export type RouteBroadcastResult = {
  routeKey: string;
  routeLabel: string;
  status: "accepted" | "known" | "rejected" | "timeout" | "error";
  latencyMs: number;
  error?: string;
};

function alreadyKnown(message: string): boolean {
  return /already known|known transaction|already imported|transaction already exists/i.test(message);
}

export async function submitRawTransactionRoute(route: BroadcastRoute, rawTx: string, expectedHash: string): Promise<RouteBroadcastResult> {
  const started = performance.now();
  if (rpcUrlQuarantined(route.url)) {
    return { routeKey: route.key, routeLabel: route.label, status: "error", latencyMs: 0, error: "Route temporarily quarantined after a quota or rate-limit response" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  try {
    const response = await fetch(route.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [rawTx] }),
      signal: controller.signal,
      cache: "no-store",
    });
    const body = await response.json() as { result?: string; error?: { message?: string } };
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    if (body.result) {
      if (body.result.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("Route returned an unexpected transaction hash");
      return { routeKey: route.key, routeLabel: route.label, status: "accepted", latencyMs };
    }
    const message = safeErrorMessage(body.error?.message || `HTTP ${response.status}`, "Route rejected transaction");
    if (response.status === 429 || rpcQuotaError(message)) quarantineRpcUrl(route.url);
    if (alreadyKnown(message)) return { routeKey: route.key, routeLabel: route.label, status: "known", latencyMs };
    return { routeKey: route.key, routeLabel: route.label, status: "rejected", latencyMs, error: message };
  } catch (error) {
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    const timeoutError = error instanceof Error && error.name === "AbortError";
    if (rpcQuotaError(error)) quarantineRpcUrl(route.url);
    return {
      routeKey: route.key,
      routeLabel: route.label,
      status: timeoutError ? "timeout" : "error",
      latencyMs,
      error: safeErrorMessage(error, timeoutError ? "Route timed out" : "Route failed"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function submitRawTransactionRoutes(
  routes: BroadcastRoute[], rawTx: string, expectedHash: string,
): Promise<{ accepted: boolean; results: RouteBroadcastResult[] }> {
  const results = await Promise.all(routes.map((route) => submitRawTransactionRoute(route, rawTx, expectedHash)));
  return { accepted: results.some((result) => result.status === "accepted" || result.status === "known"), results };
}

async function persistTelemetry(attemptId: string, startedAt: string, results: RouteBroadcastResult[]): Promise<void> {
  const completedAt = new Date().toISOString();
  await db.insert(schema.mintBroadcasts).values(results.map((result) => ({
    id: randomUUID(),
    attemptId,
    routeKey: result.routeKey,
    routeLabel: result.routeLabel,
    status: result.status,
    latencyMs: result.latencyMs,
    error: result.error || null,
    startedAt,
    completedAt,
  })));
}

/** Submit one signed payload to every route concurrently. Every route receives
 * the same raw bytes, therefore the same nonce and transaction hash. */
export async function broadcastSameHash(args: {
  attemptId: string;
  chainId: number;
  rawTx: string;
  expectedHash: string;
}): Promise<{ accepted: boolean; results: RouteBroadcastResult[] }> {
  const routes = getBroadcastRoutes(args.chainId);
  if (!routes.length) throw new Error("No transaction broadcast routes are configured");
  const startedAt = new Date().toISOString();
  const outcome = await submitRawTransactionRoutes(routes, args.rawTx, args.expectedHash);
  const results = outcome.results;
  await persistTelemetry(args.attemptId, startedAt, results).catch(() => undefined);
  return outcome;
}

/** Warm DNS/TLS/provider connections before the launch window. */
export async function warmBroadcastRoutes(chainId: number): Promise<void> {
  await Promise.allSettled(getBroadcastRoutes(chainId).map(async (route) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetch(route.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: controller.signal,
        cache: "no-store",
      });
      await response.arrayBuffer();
    } finally { clearTimeout(timeout); }
  }));
}

export function rawTransactionFingerprint(rawTx: string): string {
  return ethers.keccak256(rawTx);
}
