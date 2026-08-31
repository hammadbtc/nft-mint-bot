import { randomUUID } from "node:crypto";
import { ethers } from "ethers";
import { db, schema } from "@/lib/db";
import { getBroadcastRoutes, quarantineRpcUrl, rpcQuotaError, rpcUrlQuarantined, type BroadcastRoute } from "@/lib/chains";
import { safeErrorMessage } from "@/lib/safety";

const ROUTE_TIMEOUT_MS = 4_000;
const ROUTE_IDENTITY_TTL_MS = 15_000;
const verifiedRouteAt = new Map<string, number>();

function routeIdentityKey(route: BroadcastRoute, expectedChainId: number): string {
  return `${expectedChainId}:${route.url}`;
}

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

async function verifyBroadcastRoute(route: BroadcastRoute, expectedChainId: number): Promise<void> {
  const identityKey = routeIdentityKey(route, expectedChainId);
  if (Date.now() - (verifiedRouteAt.get(identityKey) || 0) < ROUTE_IDENTITY_TTL_MS) return;
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
    const body = await response.json() as { result?: string; error?: { message?: string } };
    const observed = body.result ? Number(BigInt(body.result)) : NaN;
    if (!response.ok || observed !== expectedChainId) {
      quarantineRpcUrl(route.url);
      throw new Error(`Broadcast route chain identity mismatch: expected ${expectedChainId}, received ${Number.isFinite(observed) ? observed : "invalid response"}`);
    }
    verifiedRouteAt.set(identityKey, Date.now());
  } finally { clearTimeout(timeout); }
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
  const identityChecks = await Promise.allSettled(routes.map((route) => verifyBroadcastRoute(route, args.chainId)));
  const verifiedRoutes = routes.filter((_, index) => identityChecks[index]?.status === "fulfilled");
  const identityFailures = routes.flatMap((route, index): RouteBroadcastResult[] => {
    const check = identityChecks[index];
    if (!check || check.status === "fulfilled") return [];
    return [{
      routeKey: route.key,
      routeLabel: route.label,
      // No transaction bytes were submitted, so this is a deterministic
      // preflight rejection rather than an ambiguous broadcast error.
      status: "rejected",
      latencyMs: 0,
      error: safeErrorMessage(check.reason, "Route failed chain identity verification"),
    }];
  });
  const startedAt = new Date().toISOString();
  const outcome = verifiedRoutes.length
    ? await submitRawTransactionRoutes(verifiedRoutes, args.rawTx, args.expectedHash)
    : { accepted: false, results: [] as RouteBroadcastResult[] };
  const results = [...outcome.results, ...identityFailures];
  await persistTelemetry(args.attemptId, startedAt, results).catch(() => undefined);
  return { accepted: outcome.accepted, results };
}

/** Warm DNS/TLS/provider connections before the launch window. */
export async function warmBroadcastRoutes(chainId: number): Promise<void> {
  const results = await Promise.allSettled(getBroadcastRoutes(chainId).map((route) => verifyBroadcastRoute(route, chainId)));
  if (!results.some((result) => result.status === "fulfilled")) throw new Error("No broadcast route passed chain identity verification");
}

export function rawTransactionFingerprint(rawTx: string): string {
  return ethers.keccak256(rawTx);
}
