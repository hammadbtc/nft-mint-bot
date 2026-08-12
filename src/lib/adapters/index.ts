import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db, schema } from "@/lib/db";
import { evmContractV1 } from "./evm-contract-v1";
import { openseaSeaDropV1 } from "./opensea-seadrop-v1";
import type { MintAdapter, ResolvedMint, SupportedCollection } from "./types";

const registry = new Map<string, MintAdapter>([
  [evmContractV1.key, evmContractV1],
  [openseaSeaDropV1.key, openseaSeaDropV1],
]);

function normalizeDomain(value: string) {
  return value.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function parseDomains(raw: string): string[] {
  try { const value: unknown = JSON.parse(raw); return Array.isArray(value) ? value.filter((item):item is string=>typeof item==="string").map(normalizeDomain) : []; }
  catch { return []; }
}

function safeUrl(input: string): URL | null {
  try { const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`; const url = new URL(candidate); return ["http:","https:"].includes(url.protocol) ? url : null; }
  catch { return null; }
}

function normalizePath(value: string): string {
  const path = value.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return path || "/";
}

export function exactUrlPathMatches(pathname: string, expected: string): boolean {
  return normalizePath(pathname).toLowerCase() === normalizePath(expected).toLowerCase();
}

function urlMatches(collection: SupportedCollection, url: URL): boolean {
  const hostname = normalizeDomain(url.hostname);
  if (!parseDomains(collection.domains).some((domain) => hostname === domain)) return false;
  try {
    const config = JSON.parse(collection.adapterConfig || "{}") as { urlMatchers?: Array<{ domain?: string; path?: string; pathPrefix?: string }> };
    if (!config.urlMatchers?.length) return true;
    return config.urlMatchers.some((matcher) => {
      if (!matcher.domain || normalizeDomain(matcher.domain) !== hostname) return false;
      const reviewedPath = matcher.path || matcher.pathPrefix;
      return !reviewedPath || exactUrlPathMatches(url.pathname, reviewedPath);
    });
  } catch { return false; }
}

async function activeCollections(): Promise<SupportedCollection[]> {
  return db.select().from(schema.collections).where(and(eq(schema.collections.active,true),eq(schema.collections.verified,true)));
}

export async function resolveMintInput(rawInput: string): Promise<ResolvedMint | { supported:false; reason:string }> {
  const input = rawInput.trim();
  if (!input || input.length > 2048) return { supported:false, reason:"Enter a valid mint URL, contract, or project name" };
  const collections = await activeCollections();
  let match: SupportedCollection | undefined;
  let source: ResolvedMint["source"] = "name";
  const isAddress = Boolean(ethers.isAddress(input));
  if (isAddress) {
    source = "contract";
    match = collections.find((item)=>item.contractAddress.toLowerCase()===input.toLowerCase());
  } else {
    const url = safeUrl(input);
    if (url && (input.includes(".") || /^https?:/i.test(input))) {
      source = "url";
      match = collections.find((item)=>urlMatches(item, url));
    } else {
      const query = input.toLowerCase();
      match = collections.find((item)=>item.slug?.toLowerCase()===query || item.name.toLowerCase()===query);
    }
  }
  if (!match) return { supported:false, reason:"This mint is not supported yet" };
  const adapter = registry.get(match.adapterKey);
  if (!adapter) return { supported:false, reason:"This mint adapter is unavailable" };
  return adapter.resolve(match, source);
}

export function supportedAdapterKeys() { return [...registry.keys()]; }

export function getMintAdapter(key: string): MintAdapter | undefined { return registry.get(key); }
