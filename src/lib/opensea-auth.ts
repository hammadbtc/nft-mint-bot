import { OpenSeaAPI, OpenSeaAuth } from "@opensea/sdk";
import type { ethers } from "ethers";

type AuthEntry = {
  auth: OpenSeaAuth;
  ready: Promise<void>;
};

const authByAddress = new Map<string, AuthEntry>();
let instantKeyPromise: Promise<{ value: string; expiresAt: number }> | undefined;
let cachedInstantKey: { value: string; expiresAt: number } | undefined;

export function configuredOpenSeaApiKey(): string | undefined {
  return process.env.OPENSEA_API_KEY?.trim() || undefined;
}

/**
 * Prefer the permanent production key. When it has not been configured yet,
 * OpenSea's official seven-day instant key keeps a reviewed launch usable.
 * The temporary key stays in process memory and is never returned to clients.
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

/**
 * Authenticate a server-controlled mint wallet with a narrowly scoped SIWE
 * token. Tokens and the backing PAT remain in memory and are never persisted.
 */
export async function openSeaApiForSigner(signer: ethers.Signer): Promise<OpenSeaAPI> {
  const address = (await signer.getAddress()).toLowerCase();
  let entry = authByAddress.get(address);
  if (!entry) {
    const auth = new OpenSeaAuth();
    entry = {
      auth,
      ready: auth.authenticate(signer, { scopes: ["read:eligibility"] }).then(() => undefined),
    };
    authByAddress.set(address, entry);
  }

  try {
    await entry.ready;
    const token = await entry.auth.getValidToken();
    return new OpenSeaAPI({ apiKey: await requireOpenSeaApiKey(), authToken: token.accessToken });
  } catch (error) {
    if (authByAddress.get(address) === entry) authByAddress.delete(address);
    throw error;
  }
}

export async function openSeaApi(): Promise<OpenSeaAPI> {
  return new OpenSeaAPI({ apiKey: await requireOpenSeaApiKey() });
}
