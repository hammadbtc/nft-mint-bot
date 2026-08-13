import { OpenSeaAPI, OpenSeaAuth } from "@opensea/sdk";
import type { ethers } from "ethers";

type AuthEntry = {
  auth: OpenSeaAuth;
  ready: Promise<void>;
};

const authByAddress = new Map<string, AuthEntry>();

export function openSeaApiKey(): string | undefined {
  return process.env.OPENSEA_API_KEY?.trim() || undefined;
}

export function requireOpenSeaApiKey(): string {
  const value = openSeaApiKey();
  if (!value) throw new Error("OPENSEA_API_KEY is required for signed-drop eligibility and minting");
  return value;
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
    return new OpenSeaAPI({ apiKey: requireOpenSeaApiKey(), authToken: token.accessToken });
  } catch (error) {
    if (authByAddress.get(address) === entry) authByAddress.delete(address);
    throw error;
  }
}

export function openSeaApi(): OpenSeaAPI {
  return new OpenSeaAPI({ apiKey: requireOpenSeaApiKey() });
}
