import {
  OpenSeaAPI,
  OpenSeaAuth,
  generateSiweMessage,
  parseSiwxMessage,
} from "@opensea/sdk";
import type { ethers } from "ethers";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { decryptPrivateKey, encryptPrivateKey } from "@/lib/vault/crypto";

const OPENSEA_API_BASE_URL = "https://api.opensea.io";
const SDK_TOKEN_LABEL = /^opensea-sdk-\d+$/;
const INSTANT_KEY_SETTING = "opensea_instant_api_key_v1";
const INSTANT_KEY_REFRESH_BUFFER_MS = 300_000;

type ScopedTokenSummary = {
  id: string;
  label: string;
  scopes: string[];
  createdAt?: string;
  expiresAt?: string;
};

type AuthEntry = { auth: OpenSeaAuth; ready: Promise<void> };
const authByAddress = new Map<string, AuthEntry>();
const AUTH_CONCURRENCY = 6;
let activeAuthentications = 0;
const authenticationWaiters: Array<() => void> = [];
let instantKeyPromise: Promise<{ value: string; expiresAt: number }> | undefined;
let cachedInstantKey: { value: string; expiresAt: number } | undefined;
let rejectedConfiguredKey: string | undefined;

export function configuredOpenSeaApiKey(): string | undefined {
  const value = process.env.OPENSEA_API_KEY?.trim() || undefined;
  return value && value !== rejectedConfiguredKey ? value : undefined;
}

type StoredInstantKey = { value: string; expiresAt: number };

async function loadStoredInstantKey(): Promise<StoredInstantKey | undefined> {
  try {
    const [row] = await db.select().from(schema.appConfig).where(eq(schema.appConfig.key, INSTANT_KEY_SETTING)).limit(1);
    if (!row) return undefined;
    const value = JSON.parse(decryptPrivateKey(row.value)) as Partial<StoredInstantKey>;
    if (typeof value.value !== "string" || !value.value || !Number.isFinite(value.expiresAt)) return undefined;
    return value as StoredInstantKey;
  } catch {
    return undefined;
  }
}

async function storeInstantKey(value: StoredInstantKey): Promise<void> {
  const encrypted = encryptPrivateKey(JSON.stringify(value));
  await db.insert(schema.appConfig).values({ key: INSTANT_KEY_SETTING, value: encrypted })
    .onConflictDoUpdate({ target: schema.appConfig.key, set: { value: encrypted, updatedAt: new Date().toISOString() } });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestInstantKeyWithRetry(): Promise<StoredInstantKey> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await OpenSeaAPI.requestInstantApiKey();
      if (!response.apiKey || !Number.isFinite(Date.parse(response.expiresAt))) {
        throw new Error("OpenSea returned an invalid instant API key response");
      }
      return { value: response.apiKey, expiresAt: Date.parse(response.expiresAt) };
    } catch (error) {
      lastError = error;
      if (!isOpenSeaRateLimitError(error) || attempt === 3) throw error;
      await wait(1_500 * (2 ** attempt));
    }
  }
  throw lastError;
}

/**
 * Prefer the permanent production key. When it has not been configured yet,
 * OpenSea's official instant key keeps a reviewed launch usable. The temporary
 * key stays in process memory and is never returned to clients.
 */
export async function requireOpenSeaApiKey(): Promise<string> {
  const configured = configuredOpenSeaApiKey();
  if (configured) return configured;
  if (cachedInstantKey && cachedInstantKey.expiresAt - Date.now() > INSTANT_KEY_REFRESH_BUFFER_MS) return cachedInstantKey.value;
  if (!instantKeyPromise) {
    instantKeyPromise = (async () => {
      const stored = await loadStoredInstantKey();
      if (stored && stored.expiresAt - Date.now() > INSTANT_KEY_REFRESH_BUFFER_MS) return stored;
      const fresh = await requestInstantKeyWithRetry();
      await storeInstantKey(fresh);
      return fresh;
    })();
  }
  try {
    cachedInstantKey = await instantKeyPromise;
    return cachedInstantKey.value;
  } finally {
    instantKeyPromise = undefined;
  }
}

export function isOpenSeaInvalidApiKeyError(error: unknown): boolean {
  return error instanceof Error && /invalid api key|unauthorized.*api key|api key.*(?:invalid|expired)/i.test(error.message);
}

function rejectConfiguredOpenSeaApiKey(error: unknown): boolean {
  const configured = process.env.OPENSEA_API_KEY?.trim();
  if (!configured || !isOpenSeaInvalidApiKeyError(error)) return false;
  if (rejectedConfiguredKey !== configured) {
    rejectedConfiguredKey = configured;
    console.warn("Configured OpenSea API key was rejected; switching to an automatically refreshed instant key");
  }
  // Concurrent OpenSea calls may both have started with the same bad key. Each
  // failed operation must retry even if another call marked the key first.
  return true;
}

export function isOpenSeaRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const value = error as Error & { statusCode?: number };
  return value.statusCode === 429 || /(?:server error|failed|error)\s*\(429\)|429\s+too many requests/i.test(value.message);
}

function requireOk(response: Response, operation: string): Promise<void> | void {
  if (response.ok) return;
  return response.text().catch(() => "").then((body) => {
    throw new Error(`${operation} failed (${response.status}): ${body}`);
  });
}

function splitSetCookieHeader(header: string): string[] {
  const sessionCookieNames = new Set(["access_token", "refresh_token"]);
  const cookies: string[] = [];
  let current = "";
  for (const segment of header.split(", ")) {
    const trimmed = segment.trim();
    const equals = trimmed.indexOf("=");
    const name = equals > 0 ? trimmed.slice(0, equals).trim() : "";
    if (sessionCookieNames.has(name) && current) {
      cookies.push(current);
      current = trimmed;
    } else if (sessionCookieNames.has(name)) {
      current = trimmed;
    } else {
      current = current ? `${current}, ${trimmed}` : trimmed;
    }
  }
  if (current) cookies.push(current);
  return cookies;
}

function extractSessionCookies(headers: Headers): string {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const raw = getSetCookie?.call(headers) ?? splitSetCookieHeader(headers.get("set-cookie") ?? "");
  const cookies = new Map<string, string>();
  for (const cookie of raw) {
    const pair = cookie.split(";")[0];
    const equals = pair.indexOf("=");
    if (equals < 0) continue;
    const name = pair.slice(0, equals).trim();
    if (name === "access_token" || name === "refresh_token") cookies.set(name, pair);
  }
  if (!cookies.has("access_token") || !cookies.has("refresh_token")) {
    throw new Error("OpenSea SIWE verification did not return session cookies");
  }
  return [...cookies.values()].join("; ");
}

async function createSiweSession(signer: ethers.Signer): Promise<string> {
  const nonceResponse = await fetch(`${OPENSEA_API_BASE_URL}/api/v2/auth/siwe/nonce`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  await requireOk(nonceResponse, "OpenSea nonce request");
  const nonceRaw = await nonceResponse.json() as { nonce?: unknown };
  if (typeof nonceRaw.nonce !== "string" || !nonceRaw.nonce) throw new Error("OpenSea returned an invalid SIWE nonce");

  const message = generateSiweMessage(await signer.getAddress(), [], nonceRaw.nonce, OPENSEA_API_BASE_URL);
  const signature = await signer.signMessage(message);
  const verification = await fetch(`${OPENSEA_API_BASE_URL}/api/v2/auth/siwe/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: parseSiwxMessage(message), signature, chainArch: "EVM" }),
  });
  await requireOk(verification, "OpenSea SIWE verification");
  return extractSessionCookies(verification.headers);
}

export function isOpenSeaScopedTokenLimitError(error: unknown): boolean {
  return error instanceof Error
    && /scoped token creation failed \(400\)/i.test(error.message)
    && /create up to \d+ scoped tokens per account/i.test(error.message);
}

export function selectStaleOpenSeaSdkToken(raw: unknown): ScopedTokenSummary | undefined {
  if (!Array.isArray(raw)) throw new Error("OpenSea returned an invalid scoped-token list");
  const candidates = raw.filter((item): item is ScopedTokenSummary => {
    if (!item || typeof item !== "object") return false;
    const value = item as Partial<ScopedTokenSummary>;
    return typeof value.id === "string" && /^\d+$/.test(value.id)
      && typeof value.label === "string" && SDK_TOKEN_LABEL.test(value.label)
      && Array.isArray(value.scopes) && value.scopes.length === 1 && value.scopes[0] === "read:eligibility";
  });
  return candidates.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt || left.expiresAt || "");
    const rightTime = Date.parse(right.createdAt || right.expiresAt || "");
    return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
  })[0];
}

/** Free one slot only from an SDK PAT with MintBot's exact eligibility scope. */
async function recoverOpenSeaScopedTokenSlot(signer: ethers.Signer): Promise<void> {
  const cookie = await createSiweSession(signer);
  const listResponse = await fetch(`${OPENSEA_API_BASE_URL}/api/v2/auth/tokens`, {
    headers: { Accept: "application/json", Cookie: cookie },
  });
  await requireOk(listResponse, "OpenSea scoped token listing");
  const stale = selectStaleOpenSeaSdkToken(await listResponse.json());
  if (!stale) throw new Error("OpenSea scoped-token limit is full and no MintBot SDK token can be safely revoked");
  const revokeResponse = await fetch(`${OPENSEA_API_BASE_URL}/api/v2/auth/tokens/${encodeURIComponent(stale.id)}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  if (!revokeResponse.ok && revokeResponse.status !== 404) await requireOk(revokeResponse, "OpenSea stale scoped token revocation");
}

async function authenticateWithRecovery(auth: OpenSeaAuth, signer: ethers.Signer) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await auth.authenticate(signer, { scopes: ["read:eligibility"] });
    } catch (error) {
      lastError = error;
      if (isOpenSeaScopedTokenLimitError(error)) {
        await recoverOpenSeaScopedTokenSlot(signer);
        return auth.authenticate(signer, { scopes: ["read:eligibility"] });
      }
      if (!isOpenSeaRateLimitError(error) || attempt === 2) throw error;
      await wait(750 * (2 ** attempt));
    }
  }
  throw lastError;
}

async function withAuthenticationSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeAuthentications >= AUTH_CONCURRENCY) {
    await new Promise<void>((resolve) => authenticationWaiters.push(resolve));
  }
  activeAuthentications += 1;
  try {
    return await operation();
  } finally {
    activeAuthentications -= 1;
    authenticationWaiters.shift()?.();
  }
}

/**
 * Reuse one narrowly-scoped PAT per wallet for its one-day lifetime. Creating
 * and revoking a PAT on every UI refresh burns OpenSea's auth rate limit. The
 * cap-recovery path above safely removes only stale MintBot-created PATs after
 * a deployment loses its in-memory cache.
 */
export async function withOpenSeaApiForSigner<T>(signer: ethers.Signer, operation: (api: OpenSeaAPI) => Promise<T>): Promise<T> {
  const address = (await signer.getAddress()).toLowerCase();
  let entry = authByAddress.get(address);
  if (!entry) {
    const auth = new OpenSeaAuth();
    const ready = withAuthenticationSlot(() => authenticateWithRecovery(auth, signer)).then(() => undefined);
    entry = { auth, ready };
    authByAddress.set(address, entry);
  }
  try {
    try {
      await entry.ready;
    } catch (error) {
      // A failed initial authentication must not poison this wallet's cache.
      // The next scan should be able to establish a fresh SIWE session.
      if (authByAddress.get(address) === entry) authByAddress.delete(address);
      throw error;
    }
    const token = await entry.auth.getValidToken();
    try {
      return await operation(new OpenSeaAPI({ apiKey: await requireOpenSeaApiKey(), authToken: token.accessToken }));
    } catch (error) {
      if (!rejectConfiguredOpenSeaApiKey(error)) throw error;
      return await operation(new OpenSeaAPI({ apiKey: await requireOpenSeaApiKey(), authToken: token.accessToken }));
    }
  } catch (error) {
    if (!isOpenSeaRateLimitError(error) && authByAddress.get(address) === entry) authByAddress.delete(address);
    throw error;
  }
}

export async function openSeaApi(): Promise<OpenSeaAPI> {
  return new OpenSeaAPI({ apiKey: await requireOpenSeaApiKey() });
}

/** Run an unauthenticated OpenSea operation, retrying once with an automatically
 * refreshed instant key when a configured production key has expired/revoked. */
export async function withOpenSeaApi<T>(operation: (api: OpenSeaAPI) => Promise<T>): Promise<T> {
  try {
    return await operation(await openSeaApi());
  } catch (error) {
    if (!rejectConfiguredOpenSeaApiKey(error)) throw error;
    return operation(await openSeaApi());
  }
}
