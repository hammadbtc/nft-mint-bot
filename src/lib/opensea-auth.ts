import {
  OpenSeaAPI,
  OpenSeaAuth,
  generateSiweMessage,
  parseSiwxMessage,
} from "@opensea/sdk";
import type { ethers } from "ethers";

const OPENSEA_API_BASE_URL = "https://api.opensea.io";
const SDK_TOKEN_LABEL = /^opensea-sdk-\d+$/;

type ScopedTokenSummary = {
  id: string;
  label: string;
  scopes: string[];
  createdAt?: string;
  expiresAt?: string;
};

const authQueueByAddress = new Map<string, Promise<void>>();
let instantKeyPromise: Promise<{ value: string; expiresAt: number }> | undefined;
let cachedInstantKey: { value: string; expiresAt: number } | undefined;

export function configuredOpenSeaApiKey(): string | undefined {
  return process.env.OPENSEA_API_KEY?.trim() || undefined;
}

/**
 * Prefer the permanent production key. When it has not been configured yet,
 * OpenSea's official instant key keeps a reviewed launch usable. The temporary
 * key stays in process memory and is never returned to clients.
 */
export async function requireOpenSeaApiKey(): Promise<string> {
  const configured = configuredOpenSeaApiKey();
  if (configured) return configured;
  if (cachedInstantKey && cachedInstantKey.expiresAt - Date.now() > 300_000) return cachedInstantKey.value;
  if (!instantKeyPromise) {
    instantKeyPromise = OpenSeaAPI.requestInstantApiKey().then((response) => {
      if (!response.apiKey || !Number.isFinite(Date.parse(response.expiresAt))) {
        throw new Error("OpenSea returned an invalid instant API key response");
      }
      return { value: response.apiKey, expiresAt: Date.parse(response.expiresAt) };
    });
  }
  try {
    cachedInstantKey = await instantKeyPromise;
    return cachedInstantKey.value;
  } finally {
    instantKeyPromise = undefined;
  }
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
  try {
    return await auth.authenticate(signer, { scopes: ["read:eligibility"] });
  } catch (error) {
    if (!isOpenSeaScopedTokenLimitError(error)) throw error;
    await recoverOpenSeaScopedTokenSlot(signer);
    return auth.authenticate(signer, { scopes: ["read:eligibility"] });
  }
}

async function runWalletAuthenticated<T>(signer: ethers.Signer, operation: (api: OpenSeaAPI) => Promise<T>): Promise<T> {
  const auth = new OpenSeaAuth();
  const token = await authenticateWithRecovery(auth, signer);
  let operationFailed = false;
  try {
    const api = new OpenSeaAPI({ apiKey: await requireOpenSeaApiKey(), authToken: token.accessToken });
    return await operation(api);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      const current = await auth.getValidToken();
      await auth.revoke(current.accessToken);
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
}

/**
 * Run one wallet-authenticated operation at a time per signer. The one-day PAT
 * is revoked immediately afterward so restarts and deploys cannot exhaust the
 * account's scoped-token limit again.
 */
export async function withOpenSeaApiForSigner<T>(signer: ethers.Signer, operation: (api: OpenSeaAPI) => Promise<T>): Promise<T> {
  const address = (await signer.getAddress()).toLowerCase();
  const previous = authQueueByAddress.get(address) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => runWalletAuthenticated(signer, operation));
  const settled = task.then(() => undefined, () => undefined);
  authQueueByAddress.set(address, settled);
  try {
    return await task;
  } finally {
    if (authQueueByAddress.get(address) === settled) authQueueByAddress.delete(address);
  }
}

export async function openSeaApi(): Promise<OpenSeaAPI> {
  return new OpenSeaAPI({ apiKey: await requireOpenSeaApiKey() });
}
